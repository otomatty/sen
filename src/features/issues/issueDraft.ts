import { isHtmlEmpty, readLocal, writeLocal } from "../../lib/utils";

// 課題作成の下書き。ワークスペースとユーザーごとに、読み込み直しても残す。
// localStorage が使えない環境でも、閉じて開き直すだけなら残るよう、メモリにも控えを置く。

export interface Draft {
  teamId: string;
  title: string;
  description: string;
  stateId: string;
  priority: number;
  assigneeId: string | null;
  labelIds: string[];
  projectId: string | null;
  cycleId: string | null;
  estimate: number | null;
  dueDate: string | null;
  parentId: string | null;
}

const DRAFT_PREFIX = "sen:issue-draft:";
const DRAFT_VERSION = 1;

const memory = new Map<string, Draft>();

function storageKey(workspaceId: string, userId: string): string {
  return `${DRAFT_PREFIX}${workspaceId}:${userId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function draftHasContent(d: Partial<Draft> | null | undefined): boolean {
  if (!d) return false;
  if (typeof d.title === "string" && d.title.trim() !== "") return true;
  return typeof d.description === "string" && !isHtmlEmpty(d.description);
}

function pickFields(raw: Record<string, unknown>): Partial<Draft> {
  const out: Partial<Draft> = {};
  if (typeof raw.title === "string") out.title = raw.title;
  if (typeof raw.description === "string") out.description = raw.description;
  if (typeof raw.teamId === "string") out.teamId = raw.teamId;
  if (typeof raw.stateId === "string") out.stateId = raw.stateId;
  if (typeof raw.priority === "number") out.priority = raw.priority;
  if (typeof raw.assigneeId === "string" || raw.assigneeId === null) out.assigneeId = raw.assigneeId;
  if (typeof raw.projectId === "string" || raw.projectId === null) out.projectId = raw.projectId;
  if (typeof raw.cycleId === "string" || raw.cycleId === null) out.cycleId = raw.cycleId;
  if (typeof raw.parentId === "string" || raw.parentId === null) out.parentId = raw.parentId;
  if (typeof raw.dueDate === "string" || raw.dueDate === null) out.dueDate = raw.dueDate;
  if (typeof raw.estimate === "number" || raw.estimate === null) out.estimate = raw.estimate;
  if (Array.isArray(raw.labelIds) && raw.labelIds.every((id) => typeof id === "string")) out.labelIds = raw.labelIds;
  return out;
}

/** 読めれば下書き、無いか壊れていれば undefined（呼び出し側がメモリの控えを使う） */
function readStored(key: string): Partial<Draft> | undefined {
  const raw = readLocal<unknown>(key, undefined);
  if (!isRecord(raw) || raw.v !== DRAFT_VERSION || !isRecord(raw.draft)) return undefined;
  return pickFields(raw.draft);
}

function forget(key: string) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // 消せなくても動作は続ける
  }
}

export function loadIssueDraft(workspaceId: string, userId: string): Partial<Draft> | null {
  const key = storageKey(workspaceId, userId);
  const stored = readStored(key);
  if (stored === undefined) {
    const cached = memory.get(key);
    return cached && draftHasContent(cached) ? cached : null;
  }
  return draftHasContent(stored) ? stored : null;
}

export function saveIssueDraft(workspaceId: string, userId: string, draft: Draft): void {
  const key = storageKey(workspaceId, userId);
  if (!draftHasContent(draft)) {
    forget(key);
    return;
  }
  memory.set(key, draft);
  writeLocal(key, { v: DRAFT_VERSION, draft });
}

export function clearIssueDraft(workspaceId: string, userId: string): void {
  forget(storageKey(workspaceId, userId));
}

export function clearAllIssueDrafts(): void {
  memory.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // 消せなくても動作は続ける
  }
}
