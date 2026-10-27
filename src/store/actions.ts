import type {
  AppNotification,
  Cycle,
  Issue,
  IssuePatch,
  Label,
  Mutation,
  Project,
  StateType,
  Team,
  UserSettings,
  WorkflowState,
} from "../../shared/types";
import { addDays, mondayOf } from "../../shared/dates";
import { DEFAULT_STATES } from "../../shared/constants";
import { localYmd, uuid } from "../lib/utils";
import { getData } from "./data";
import { engine, type Effect } from "./engine";
import { toast } from "./ui";

// ---------------------------------------------------------------------------
// 画面から呼ぶ操作。すべて「手元に即反映 → 裏でサーバーへ送信」。
// ---------------------------------------------------------------------------

interface UndoEntry {
  label: string;
  run: () => void;
}
const undoStack: UndoEntry[] = [];

function pushUndo(entry: UndoEntry) {
  undoStack.push(entry);
  if (undoStack.length > 50) undoStack.shift();
}

export function undo(): boolean {
  const e = undoStack.pop();
  if (!e) {
    toast("元に戻せる操作はありません");
    return false;
  }
  e.run();
  toast(`元に戻しました：${e.label}`);
  return true;
}

function m(mutation: Mutation, effects: Effect[] = []) {
  return engine.mutate(mutation, effects);
}

// ---------------- 課題 ----------------
function stateTimes(prev: Issue, stateId: string, now: number): Partial<Issue> {
  const st = getData().states[stateId];
  if (!st) return {};
  switch (st.type) {
    case "started":
      return { startedAt: prev.startedAt ?? now, completedAt: null, canceledAt: null };
    case "completed":
      return { startedAt: prev.startedAt ?? now, completedAt: now, canceledAt: null };
    case "canceled":
      return { canceledAt: now, completedAt: null };
    default:
      return { startedAt: null, completedAt: null, canceledAt: null };
  }
}

function applyIssuePatch(prev: Issue | undefined, patch: IssuePatch, now: number): Issue | undefined {
  if (!prev) return prev;
  const next: Issue = { ...prev, ...patch, updatedAt: now };
  if (patch.stateId && patch.stateId !== prev.stateId) Object.assign(next, stateTimes(prev, patch.stateId, now));
  if (patch.assigneeId && !next.subscriberIds.includes(patch.assigneeId)) {
    next.subscriberIds = [...next.subscriberIds, patch.assigneeId];
  }
  if (patch.teamId && patch.teamId !== prev.teamId) {
    // 別チームへ移動：同じ種類のステータスに寄せる
    const d = getData();
    const oldType = d.states[prev.stateId]?.type;
    if (!patch.stateId) {
      const st = statesForTeam(patch.teamId).find((s) => s.type === oldType) ?? statesForTeam(patch.teamId)[0];
      if (st) next.stateId = st.id;
    }
    if (patch.cycleId === undefined) next.cycleId = null;
    const nums = Object.values(d.issues)
      .filter((i) => i.teamId === patch.teamId)
      .map((i) => i.number);
    next.number = (nums.length ? Math.max(...nums) : 0) + 1;
  }
  return next;
}

const FIELD_LABEL: Partial<Record<keyof IssuePatch, string>> = {
  stateId: "ステータスの変更",
  priority: "優先度の変更",
  assigneeId: "担当者の変更",
  labelIds: "ラベルの変更",
  projectId: "プロジェクトの変更",
  cycleId: "サイクルの変更",
  estimate: "見積もりの変更",
  dueDate: "期日の変更",
  title: "タイトルの変更",
  parentId: "親課題の変更",
  teamId: "チームの移動",
};

export function updateIssues(ids: string[], patch: IssuePatch | ((issue: Issue) => IssuePatch), opts: { undo?: boolean } = {}) {
  const now = Date.now();
  const inverses: [string, IssuePatch][] = [];
  for (const id of ids) {
    const prev = engine.current<Issue>("issues", id);
    if (!prev) continue;
    const p = typeof patch === "function" ? patch(prev) : patch;
    const keys = (Object.keys(p) as (keyof IssuePatch)[]).filter(
      (k) => JSON.stringify(prev[k as keyof Issue]) !== JSON.stringify(p[k]),
    );
    if (!keys.length) continue;
    const clean: IssuePatch = {};
    const inverse: IssuePatch = {};
    for (const k of keys) {
      (clean as Record<string, unknown>)[k] = p[k];
      (inverse as Record<string, unknown>)[k] = prev[k as keyof Issue];
    }
    inverses.push([id, inverse]);
    m({ type: "issue.update", args: { id, patch: clean } }, [
      { c: "issues", id, fn: (v: Issue | undefined) => applyIssuePatch(v, clean, now) },
    ]);
  }
  if (opts.undo !== false && inverses.length) {
    const first = Object.keys(inverses[0][1])[0] as keyof IssuePatch;
    pushUndo({
      label: FIELD_LABEL[first] ?? "課題の変更",
      run: () => inverses.forEach(([id, inv]) => updateIssues([id], inv, { undo: false })),
    });
  }
  return inverses.length;
}

export function statesForTeam(teamId: string): WorkflowState[] {
  const order: Record<StateType, number> = { backlog: 0, unstarted: 1, started: 2, completed: 3, canceled: 4 };
  return Object.values(getData().states)
    .filter((s) => s.teamId === teamId)
    .sort((a, b) => order[a.type] - order[b.type] || a.position - b.position);
}

export function defaultStateFor(teamId: string, type: StateType = "unstarted"): WorkflowState | undefined {
  const list = statesForTeam(teamId);
  return list.find((s) => s.type === type) ?? list.find((s) => s.type === "unstarted") ?? list[0];
}

export interface NewIssueInput {
  teamId: string;
  title: string;
  description?: string;
  stateId?: string;
  priority?: number;
  assigneeId?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  labelIds?: string[];
  estimate?: number | null;
  dueDate?: string | null;
}

export function createIssue(input: NewIssueInput): { id: string; identifier: string; done: Promise<boolean> } {
  const d = getData();
  const id = uuid();
  const now = Date.now();
  const team = d.teams[input.teamId];
  const stateId = input.stateId ?? defaultStateFor(input.teamId)?.id ?? "";
  const teamIssues = Object.values(d.issues).filter((i) => i.teamId === input.teamId);
  const number = (teamIssues.length ? Math.max(...teamIssues.map((i) => i.number)) : 0) + 1;
  const sameState = teamIssues.filter((i) => i.stateId === stateId);
  const sortOrder = (sameState.length ? Math.min(...sameState.map((i) => i.sortOrder)) : 0) - 1;
  const meId = d.meId!;
  const issue: Issue = {
    id,
    teamId: input.teamId,
    number,
    title: input.title.trim(),
    description: input.description ?? "",
    stateId,
    priority: input.priority ?? 0,
    assigneeId: input.assigneeId ?? null,
    creatorId: meId,
    projectId: input.projectId ?? null,
    cycleId: input.cycleId ?? null,
    parentId: input.parentId ?? null,
    labelIds: input.labelIds ?? [],
    subscriberIds: [...new Set([meId, input.assigneeId].filter(Boolean) as string[])],
    estimate: input.estimate ?? null,
    dueDate: input.dueDate ?? null,
    sortOrder,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
  };
  Object.assign(issue, stateTimes(issue, stateId, now));
  const done = m(
    {
      type: "issue.create",
      args: {
        id,
        teamId: input.teamId,
        title: issue.title,
        description: issue.description,
        stateId,
        priority: issue.priority,
        assigneeId: issue.assigneeId,
        projectId: issue.projectId,
        cycleId: issue.cycleId,
        parentId: issue.parentId,
        labelIds: issue.labelIds,
        estimate: issue.estimate,
        dueDate: issue.dueDate,
        sortOrder,
      },
    },
    [{ c: "issues", id, fn: (prev: Issue | undefined) => prev ?? issue }],
  );
  pushUndo({ label: "課題の作成", run: () => archiveIssues([id], { undo: false }) });
  return { id, identifier: `${team?.key ?? "?"}-${number}`, done };
}

export function archiveIssues(ids: string[], opts: { undo?: boolean } = {}) {
  const now = Date.now();
  for (const id of ids) {
    m({ type: "issue.archive", args: { id } }, [
      { c: "issues", id, fn: (v: Issue | undefined) => v && { ...v, archivedAt: now } },
    ]);
  }
  if (opts.undo !== false) pushUndo({ label: "課題の削除", run: () => restoreIssues(ids) });
  return ids.length;
}

/** Git のブランチ名（例: taro/eng-12） */
export function branchName(issueId: string): string {
  const d = getData();
  const issue = d.issues[issueId];
  const team = issue ? d.teams[issue.teamId] : undefined;
  const me = d.meId ? d.users[d.meId] : undefined;
  const user = (me?.email ?? "me").split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
  return `${user}/${(team?.key ?? "x").toLowerCase()}-${issue?.number ?? 0}`;
}

export function restoreIssues(ids: string[]) {
  for (const id of ids) {
    m({ type: "issue.restore", args: { id } }, [
      { c: "issues", id, fn: (v: Issue | undefined) => v && { ...v, archivedAt: null } },
    ]);
  }
}

export function toggleSubscription(issueId: string) {
  const d = getData();
  const issue = d.issues[issueId];
  if (!issue || !d.meId) return;
  const on = issue.subscriberIds.includes(d.meId);
  updateIssues(
    [issueId],
    { subscriberIds: on ? issue.subscriberIds.filter((x) => x !== d.meId) : [...issue.subscriberIds, d.meId] },
    { undo: false },
  );
  toast(on ? "通知の購読を解除しました" : "この課題の通知を購読しました");
}

// ---------------- コメント ----------------
export function addComment(issueId: string, body: string) {
  const id = uuid();
  const now = Date.now();
  const meId = getData().meId!;
  return m({ type: "comment.create", args: { id, issueId, body } }, [
    {
      c: "comments",
      id,
      fn: (prev) => prev ?? { id, issueId, userId: meId, body, createdAt: now, updatedAt: now, editedAt: null },
    },
  ]);
}

export function updateComment(id: string, body: string) {
  const now = Date.now();
  return m({ type: "comment.update", args: { id, body } }, [
    { c: "comments", id, fn: (v) => v && { ...v, body, editedAt: now, updatedAt: now } },
  ]);
}

export function deleteComment(id: string) {
  return m({ type: "comment.delete", args: { id } }, [{ c: "comments", id, fn: () => undefined }]);
}

// ---------------- ラベル ----------------
export function createLabel(name: string, color: string): string {
  const id = uuid();
  m({ type: "label.create", args: { id, name, color } }, [{ c: "labels", id, fn: (p) => p ?? ({ id, name, color } as Label) }]);
  return id;
}
export function updateLabel(id: string, patch: { name?: string; color?: string }) {
  m({ type: "label.update", args: { id, ...patch } }, [{ c: "labels", id, fn: (v) => v && { ...v, ...patch } }]);
}
export function deleteLabel(id: string) {
  const affected = Object.values(getData().issues).filter((i) => i.labelIds.includes(id));
  m({ type: "label.delete", args: { id } }, [
    { c: "labels", id, fn: () => undefined },
    ...affected.map((i) => ({
      c: "issues" as const,
      id: i.id,
      fn: (v: Issue | undefined) => v && { ...v, labelIds: v.labelIds.filter((x) => x !== id) },
    })),
  ]);
}

// ---------------- プロジェクト ----------------
export function createProject(input: Partial<Project> & { name: string }): string {
  const id = uuid();
  const now = Date.now();
  const projects = Object.values(getData().projects);
  const project: Project = {
    id,
    name: input.name,
    description: input.description ?? "",
    status: input.status ?? "planned",
    leadId: input.leadId ?? null,
    teamIds: input.teamIds ?? [],
    startDate: input.startDate ?? null,
    targetDate: input.targetDate ?? null,
    color: input.color ?? "#6470e8",
    icon: input.icon ?? null,
    sortOrder: (projects.length ? Math.max(...projects.map((p) => p.sortOrder)) : 0) + 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  m(
    {
      type: "project.create",
      args: {
        id,
        name: project.name,
        description: project.description,
        status: project.status,
        leadId: project.leadId,
        teamIds: project.teamIds,
        startDate: project.startDate,
        targetDate: project.targetDate,
        color: project.color,
        icon: project.icon,
      },
    },
    [{ c: "projects", id, fn: (p) => p ?? project }],
  );
  return id;
}

export function updateProject(id: string, patch: Partial<Project>) {
  const now = Date.now();
  const allowed: (keyof Project)[] = ["name", "description", "status", "leadId", "teamIds", "startDate", "targetDate", "color", "icon", "sortOrder"];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof Project)));
  m({ type: "project.update", args: { id, patch: clean } }, [
    { c: "projects", id, fn: (v) => v && { ...v, ...clean, updatedAt: now } },
  ]);
}

export function archiveProject(id: string) {
  const affected = Object.values(getData().issues).filter((i) => i.projectId === id);
  m({ type: "project.archive", args: { id } }, [
    { c: "projects", id, fn: () => undefined },
    ...affected.map((i) => ({ c: "issues" as const, id: i.id, fn: (v: Issue | undefined) => v && { ...v, projectId: null } })),
  ]);
}

// ---------------- サイクル ----------------
export function createCycle(teamId: string): string {
  const d = getData();
  const team = d.teams[teamId];
  const cycles = Object.values(d.cycles).filter((c) => c.teamId === teamId);
  const last = cycles.sort((a, b) => b.number - a.number)[0];
  const weeks = team?.cycleDuration ?? 2;
  const today = localYmd();
  let startsAt = last ? addDays(last.endsAt, 1) : mondayOf(today);
  if (startsAt < mondayOf(today) && !cycles.some((c) => c.startsAt <= today && c.endsAt >= today)) startsAt = mondayOf(today);
  const endsAt = addDays(startsAt, weeks * 7 - 1);
  const id = uuid();
  const cycle: Cycle = { id, teamId, number: (last?.number ?? 0) + 1, name: null, startsAt, endsAt };
  m({ type: "cycle.create", args: { id, teamId, startsAt, endsAt } }, [{ c: "cycles", id, fn: (p) => p ?? cycle }]);
  return id;
}

export function updateCycle(id: string, patch: Partial<Pick<Cycle, "name" | "startsAt" | "endsAt">>) {
  m({ type: "cycle.update", args: { id, patch } }, [{ c: "cycles", id, fn: (v) => v && { ...v, ...patch } }]);
}

export function deleteCycle(id: string) {
  const affected = Object.values(getData().issues).filter((i) => i.cycleId === id);
  m({ type: "cycle.delete", args: { id } }, [
    { c: "cycles", id, fn: () => undefined },
    ...affected.map((i) => ({ c: "issues" as const, id: i.id, fn: (v: Issue | undefined) => v && { ...v, cycleId: null } })),
  ]);
}

// ---------------- チーム・ワークフロー ----------------
export function createTeam(name: string, key: string, color: string): string {
  const id = uuid();
  const now = Date.now();
  const team: Team = { id, name, key: key.toUpperCase(), color, cycleDuration: 2, cyclesEnabled: true, createdAt: now };
  m({ type: "team.create", args: { id, name, key: team.key, color } }, [{ c: "teams", id, fn: (p) => p ?? team }]);
  return id;
}

export function updateTeam(id: string, patch: Partial<Pick<Team, "name" | "key" | "color" | "cycleDuration" | "cyclesEnabled">>) {
  m({ type: "team.update", args: { id, patch } }, [{ c: "teams", id, fn: (v) => v && { ...v, ...patch } }]);
}

export function createState(teamId: string, name: string, type: StateType, color: string) {
  const id = uuid();
  const same = statesForTeam(teamId).filter((s) => s.type === type);
  const position = same.length ? Math.max(...same.map((s) => s.position)) + 0.5 : DEFAULT_STATES.length;
  m({ type: "state.create", args: { id, teamId, name, type, color } }, [
    { c: "states", id, fn: (p) => p ?? ({ id, teamId, name, type, color, position } as WorkflowState) },
  ]);
}

export function updateState(id: string, patch: Partial<Pick<WorkflowState, "name" | "color" | "position">>) {
  m({ type: "state.update", args: { id, patch } }, [{ c: "states", id, fn: (v) => v && { ...v, ...patch } }]);
}

export function deleteState(id: string, moveToStateId: string) {
  const affected = Object.values(getData().issues).filter((i) => i.stateId === id);
  m({ type: "state.delete", args: { id, moveToStateId } }, [
    { c: "states", id, fn: () => undefined },
    ...affected.map((i) => ({ c: "issues" as const, id: i.id, fn: (v: Issue | undefined) => v && { ...v, stateId: moveToStateId } })),
  ]);
}

// ---------------- 通知 ----------------
export function setNotificationRead(id: string, read: boolean) {
  const now = Date.now();
  m({ type: "notification.update", args: { id, patch: { readAt: read ? now : null } } }, [
    { c: "notifications", id, fn: (v: AppNotification | undefined) => v && { ...v, readAt: read ? now : null } },
  ]);
}

export function archiveNotification(id: string) {
  const now = Date.now();
  m({ type: "notification.update", args: { id, patch: { archivedAt: now, readAt: now } } }, [
    { c: "notifications", id, fn: (v: AppNotification | undefined) => v && { ...v, archivedAt: now, readAt: v.readAt ?? now } },
  ]);
  pushUndo({
    label: "通知の削除",
    run: () =>
      m({ type: "notification.update", args: { id, patch: { archivedAt: null } } }, [
        { c: "notifications", id, fn: (v: AppNotification | undefined) => v && { ...v, archivedAt: null } },
      ]),
  });
}

export function snoozeNotification(id: string, until: number) {
  m({ type: "notification.update", args: { id, patch: { snoozedUntil: until } } }, [
    { c: "notifications", id, fn: (v: AppNotification | undefined) => v && { ...v, snoozedUntil: until } },
  ]);
}

export function markAllNotificationsRead() {
  const now = Date.now();
  const unread = Object.values(getData().notifications).filter((n) => !n.readAt && !n.archivedAt);
  m(
    { type: "notification.markAllRead", args: {} },
    unread.map((n) => ({ c: "notifications" as const, id: n.id, fn: (v: AppNotification | undefined) => v && { ...v, readAt: now } })),
  );
}

// ---------------- ワークスペース・ユーザー ----------------
export function updateWorkspaceName(name: string) {
  m({ type: "workspace.update", args: { name } });
}

export function regenerateInvite() {
  m({ type: "workspace.regenerateInvite", args: {} });
}

export function updateMe(patch: { name?: string; avatarColor?: string; settings?: UserSettings }) {
  const id = getData().meId!;
  m({ type: "user.update", args: patch }, [{ c: "users", id, fn: (v) => v && { ...v, ...patch } }]);
}

export function updateSettings(patch: Partial<UserSettings>) {
  const d = getData();
  const me = d.users[d.meId!] as { settings?: UserSettings } | undefined;
  updateMe({ settings: { ...(me?.settings ?? {}), ...patch } });
}

export function setMemberRole(userId: string, role: "admin" | "member") {
  m({ type: "member.update", args: { userId, role } }, [{ c: "users", id: userId, fn: (v) => v && { ...v, role } }]);
}

export function removeMember(userId: string) {
  const affected = Object.values(getData().issues).filter((i) => i.assigneeId === userId);
  m({ type: "member.remove", args: { userId } }, [
    { c: "users", id: userId, fn: () => undefined },
    ...affected.map((i) => ({ c: "issues" as const, id: i.id, fn: (v: Issue | undefined) => v && { ...v, assigneeId: null } })),
  ]);
}
