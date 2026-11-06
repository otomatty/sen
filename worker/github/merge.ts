// 課題の 3-way 比較と、開閉・ラベル・担当者の対応。DB も fetch も使わない。

import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import type { StateType } from "../../shared/types";

export type OpenClosed = "open" | "closed";
export type MergeAction = "none" | "push" | "pull" | "sen-wins";
/** 開閉と閉じた理由。github_issue_links.base_state に保存する */
export type SyncState = "open" | "closed:completed" | "closed:not_planned" | "closed:duplicate";

const DUPLICATE_STATE_NAME = "重複";

export interface WorkflowStateRef {
  id: string;
  name: string;
  type: StateType;
  position: number;
}

/** 説明が両方で変わったとき、Sen に残すコメントの先頭。続けて GitHub 側の本文そのもの */
export const BODY_CONFLICT_NOTE =
  "GitHub 側の説明と同時に変わったため、Sen の説明を残しました。GitHub 側の説明は次のとおりです。\n";

/** 完了は completed、名前が「重複」のキャンセルは duplicate、ほかのキャンセルは not_planned */
export function senSyncState(type: StateType, name?: string | null): SyncState {
  if (type === "completed") return "closed:completed";
  if (type === "canceled") return name === DUPLICATE_STATE_NAME ? "closed:duplicate" : "closed:not_planned";
  return "open";
}

/** closed で理由が completed・not_planned・duplicate 以外（null や reopened など）は completed */
export function githubSyncState(state: string, reason: string | null | undefined): SyncState {
  if (state !== "closed") return "open";
  if (reason === "not_planned") return "closed:not_planned";
  if (reason === "duplicate") return "closed:duplicate";
  return "closed:completed";
}

export function syncStateParts(state: SyncState): { openClosed: OpenClosed; reason: "completed" | "not_planned" | "duplicate" | null } {
  if (state === "open") return { openClosed: "open", reason: null };
  if (state === "closed:not_planned") return { openClosed: "closed", reason: "not_planned" };
  if (state === "closed:duplicate") return { openClosed: "closed", reason: "duplicate" };
  return { openClosed: "closed", reason: "completed" };
}

/** GitHub に送る state と state_reason。開くときは reopened */
export function githubStateWrite(state: SyncState): { state: OpenClosed; state_reason: "completed" | "not_planned" | "duplicate" | "reopened" } {
  const parts = syncStateParts(state);
  if (parts.openClosed === "open") return { state: "open", state_reason: "reopened" };
  return { state: "closed", state_reason: parts.reason ?? "completed" };
}

/**
 * 前回の値・Sen・GitHub。
 * 片方だけ変わっていればその値。両方変わって同じなら何もしない。違えば Sen を優先。
 */
export function mergeScalar<T>(base: T, sen: T, github: T): MergeAction {
  const senChanged = sen !== base;
  const githubChanged = github !== base;
  if (!senChanged && !githubChanged) return "none";
  if (senChanged && !githubChanged) return "push";
  if (!senChanged && githubChanged) return "pull";
  if (sen === github) return "none";
  return "sen-wins";
}

/**
 * 前回・Sen・GitHub を「開閉と理由」で 3-way にする。
 * 古い base の "closed" は理由が分からないので、その回は開閉だけで比べる。
 */
export function mergeOpenClosed(base: string, sen: SyncState, github: SyncState): MergeAction {
  if (base === "closed") return mergeScalar("closed", asOpenClosed(sen), asOpenClosed(github));
  return mergeScalar(isSyncState(base) ? base : "open", sen, github);
}

/** 両側にある名前（小文字）だけを足し引きする */
export function mergeLabels(base: string[], sen: string[], github: string[], common: string[]): string[] {
  const commonSet = names(common);
  const b = intersect(names(base), commonSet);
  const s = intersect(names(sen), commonSet);
  const g = intersect(names(github), commonSet);
  const senAdded = subtract(s, b);
  const senRemoved = subtract(b, s);
  const githubAdded = subtract(g, b);
  const githubRemoved = subtract(b, g);
  const final = subtract(subtract(unite(unite(b, senAdded), githubAdded), senRemoved), githubRemoved);
  return [...final].sort();
}

/**
 * GitHub 側の担当者。base の人がまだいればその人。
 * いなければ、メンバーに結び付く最初の人。いなければ無し。
 */
export function resolveGitHubAssignee(githubLogins: string[], base: string | null, memberLogins: ReadonlySet<string>): string | null {
  const lowers = githubLogins.map((login) => login.toLowerCase());
  if (base && lowers.includes(base.toLowerCase())) return base.toLowerCase();
  return lowers.find((login) => memberLogins.has(login)) ?? null;
}

/** base の人を外し、新しい人を足す。GitHub にしかいない担当者は残す */
export function nextGitHubAssignees(current: string[], base: string | null, next: string | null): string[] {
  const baseLogin = base?.toLowerCase() ?? null;
  const nextLogin = next?.toLowerCase() ?? null;
  const kept = current.filter((login) => login.toLowerCase() !== baseLogin);
  if (nextLogin && !kept.some((login) => login.toLowerCase() === nextLogin)) kept.push(nextLogin);
  return kept;
}

/** GitHub → Sen。open で完了・キャンセルのときだけ未着手へ。closed は種類の最初 */
export function stateIdForGitHub(states: WorkflowStateRef[], ghState: OpenClosed, reason: string | null, currentType: StateType): string | null {
  const ordered = sortStates(states);
  if (ghState === "open") {
    if (currentType !== "completed" && currentType !== "canceled") return null;
    return ordered.find((state) => state.type === "unstarted")?.id ?? null;
  }
  if (reason === "completed") return ordered.find((state) => state.type === "completed")?.id ?? null;
  if (reason === "duplicate") {
    return (
      ordered.find((state) => state.type === "canceled" && state.name === DUPLICATE_STATE_NAME)?.id ??
      ordered.find((state) => state.type === "canceled")?.id ??
      null
    );
  }
  return ordered.find((state) => state.type === "canceled")?.id ?? null;
}

/** 新しい課題。open なら未着手の最初 */
export function initialStateId(states: WorkflowStateRef[], ghState: OpenClosed, reason: string | null): string | null {
  if (ghState === "open") {
    const ordered = sortStates(states);
    return ordered.find((state) => state.type === "unstarted")?.id ?? ordered[0]?.id ?? null;
  }
  return stateIdForGitHub(states, ghState, reason, "completed");
}

const COMMENT_OMISSION = "…（長いため一部を省きました。全文は Sen にあります）";

/** 名前と印を足しても Sen の上限を超えない。印は残し、サロゲートペアの途中では切らない */
export function formatOutboundComment(name: string, body: string, commentId: string): string {
  const head = `**${name}**（Sen）\n\n`;
  const marker = `\n\n<!-- sen:comment:${commentId} -->`;
  const full = `${head}${body}${marker}`;
  if (full.length <= MARKDOWN_MAX_LENGTH) return full;
  const note = `\n\n${COMMENT_OMISSION}`;
  const room = MARKDOWN_MAX_LENGTH - head.length - note.length - marker.length;
  if (room < 0) return `${truncateUtf16(head, Math.max(0, MARKDOWN_MAX_LENGTH - marker.length))}${marker}`;
  return `${head}${truncateUtf16(body, room)}${note}${marker}`;
}

function truncateUtf16(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const unit = text.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function isOwnGitHubComment(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes("<!-- sen:comment:");
}

export function parseIssueRef(ref: string, fallbackFullName: string): { fullName: string; number: number } | null {
  const text = ref.trim();
  const only = /^(\d{1,9})$/.exec(text);
  if (only) return numbered(fallbackFullName, Number(only[1]));
  const hash = /^([^/\s#]+)\/([^/\s#]+)#(\d{1,9})$/.exec(text);
  if (hash) return numbered(`${hash[1]}/${hash[2]}`, Number(hash[3]));
  const url = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d{1,9})(?:[/?#].*)?$/i.exec(text);
  if (url) return numbered(`${url[1]}/${url[2]}`, Number(url[3]));
  return null;
}

export function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const i = fullName.indexOf("/");
  if (i <= 0 || i !== fullName.lastIndexOf("/") || i === fullName.length - 1) return null;
  return { owner: fullName.slice(0, i), repo: fullName.slice(i + 1) };
}

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function sameNameSet(a: string[], b: string[]): boolean {
  const left = names(a);
  const right = names(b);
  if (left.size !== right.size) return false;
  for (const name of left) if (!right.has(name)) return false;
  return true;
}

export function issueNumberFromComment(issueUrl: string | null | undefined, htmlUrl: string | null | undefined): number | null {
  const fromApi = /\/issues\/(\d+)$/.exec(issueUrl ?? "");
  if (fromApi) return Number(fromApi[1]);
  const fromHtml = /\/issues\/(\d+)/.exec(htmlUrl ?? "");
  return fromHtml ? Number(fromHtml[1]) : null;
}

function isSyncState(value: string): value is SyncState {
  return value === "open" || value === "closed:completed" || value === "closed:not_planned" || value === "closed:duplicate";
}

function asOpenClosed(state: string): OpenClosed {
  return state === "open" ? "open" : "closed";
}

function numbered(fullName: string, number: number): { fullName: string; number: number } | null {
  if (!fullName.includes("/") || !Number.isInteger(number) || number < 1) return null;
  return { fullName, number };
}

function names(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}

function subtract(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (!b.has(value)) out.add(value);
  return out;
}

function unite(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  for (const value of b) out.add(value);
  return out;
}

const FORWARD_RANK: Record<StateType, number | null> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: null,
};

/**
 * 前にしか進めない。バックログ < 未着手 < 進行中（同じ種類の中は position）< 完了。
 * 今のステータスが対象と同じか、それより後ろなら null。キャンセルの課題は動かさない。
 * 移動先がキャンセル（この並びに無い）のときも null。
 */
export function advanceStateId(states: WorkflowStateRef[], currentId: string, targetId: string | null): string | null {
  if (!targetId || targetId === currentId) return null;
  const current = states.find((state) => state.id === currentId);
  const target = states.find((state) => state.id === targetId);
  if (!current || !target) return null;
  const currentRank = FORWARD_RANK[current.type];
  const targetRank = FORWARD_RANK[target.type];
  if (currentRank == null || targetRank == null) return null;
  if (targetRank > currentRank) return targetId;
  if (targetRank < currentRank) return null;
  return target.position > current.position ? targetId : null;
}

function sortStates(states: WorkflowStateRef[]): WorkflowStateRef[] {
  return [...states].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
