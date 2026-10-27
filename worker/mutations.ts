import { DEFAULT_STATES, PALETTE, AVATAR_COLORS } from "../shared/constants";
import { addDays, isValidYmd, mondayOf, todayYmd } from "../shared/dates";
import type { ActivityType, IssueRelation, Me, Mutation, NotificationType, RelationType, Role, StateType } from "../shared/types";
import { all, first, run, stmt, batch } from "./db";
import type { WorkspaceRow } from "./env";
import { randomToken } from "./auth";
import type { Change } from "./sync";

export class MutationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface MutationCtx {
  db: D1Database;
  ws: WorkspaceRow;
  user: Me;
  role: Role;
  now: number;
  changes: Change[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
const STATE_TYPES: StateType[] = ["backlog", "unstarted", "started", "completed", "canceled"];

function fail(msg: string, status = 400): never {
  throw new MutationError(msg, status);
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) fail("不正な ID です");
}

function cleanText(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") fail(`${field}が不正です`);
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!t) fail(`${field}を入力してください`);
  if (t.length > max) fail(`${field}は${max}文字以内で入力してください`);
  return t;
}

/** 表示は必ず ProseMirror のスキーマを通すが、念のため危険なものは保存前に取り除く */
export function sanitizeHtml(v: unknown, max = 200_000): string {
  if (typeof v !== "string") return "";
  if (v.length > max) fail("本文が長すぎます");
  return v
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseJsonArray(v: unknown): string[] {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const RELATION_TYPES: RelationType[] = ["blocks", "related", "duplicate"];

function parseRelations(v: unknown): IssueRelation[] {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    if (!Array.isArray(a)) return [];
    return a.filter(
      (r): r is IssueRelation =>
        !!r && typeof r.issueId === "string" && RELATION_TYPES.includes(r.type as RelationType),
    );
  } catch {
    return [];
  }
}

// ---- 取得系ヘルパー ----
async function getIssue(ctx: MutationCtx, id: unknown): Promise<Row> {
  assertId(id);
  const r = await first<Row>(ctx.db, "SELECT * FROM issues WHERE id = ? AND workspace_id = ?", id, ctx.ws.id);
  if (!r) fail("課題が見つかりません", 404);
  return r;
}

async function getTeam(ctx: MutationCtx, id: unknown): Promise<Row> {
  assertId(id);
  const r = await first<Row>(ctx.db, "SELECT * FROM teams WHERE id = ? AND workspace_id = ?", id, ctx.ws.id);
  if (!r) fail("チームが見つかりません", 404);
  return r;
}

async function getState(ctx: MutationCtx, id: unknown, teamId?: string): Promise<Row> {
  assertId(id);
  const r = await first<Row>(ctx.db, "SELECT * FROM workflow_states WHERE id = ? AND workspace_id = ?", id, ctx.ws.id);
  if (!r) fail("ステータスが見つかりません", 404);
  if (teamId && r.team_id !== teamId) fail("ステータスがチームと一致しません");
  return r;
}

async function assertMember(ctx: MutationCtx, userId: unknown): Promise<string> {
  assertId(userId);
  const r = await first<Row>(
    ctx.db,
    "SELECT user_id FROM members WHERE workspace_id = ? AND user_id = ?",
    ctx.ws.id,
    userId,
  );
  if (!r) fail("メンバーが見つかりません", 404);
  return userId;
}

async function assertLabels(ctx: MutationCtx, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids)) fail("ラベルが不正です");
  const uniq = [...new Set(ids)] as string[];
  uniq.forEach(assertId);
  if (!uniq.length) return [];
  const rows = await all<{ id: string }>(
    ctx.db,
    `SELECT id FROM labels WHERE workspace_id = ? AND id IN (${uniq.map(() => "?").join(",")})`,
    ctx.ws.id,
    ...uniq,
  );
  if (rows.length !== uniq.length) fail("ラベルが見つかりません", 404);
  return uniq;
}

async function assertProject(ctx: MutationCtx, id: unknown): Promise<string> {
  assertId(id);
  const r = await first<Row>(
    ctx.db,
    "SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND archived_at IS NULL",
    id,
    ctx.ws.id,
  );
  if (!r) fail("プロジェクトが見つかりません", 404);
  return id;
}

async function assertCycle(ctx: MutationCtx, id: unknown, teamId: string): Promise<string> {
  assertId(id);
  const r = await first<Row>(ctx.db, "SELECT team_id FROM cycles WHERE id = ? AND workspace_id = ?", id, ctx.ws.id);
  if (!r) fail("サイクルが見つかりません", 404);
  if (r.team_id !== teamId) fail("サイクルがチームと一致しません");
  return id;
}

async function assertParent(ctx: MutationCtx, parentId: unknown, selfId: string): Promise<string> {
  assertId(parentId);
  if (parentId === selfId) fail("自分自身を親課題にはできません");
  let cur: string | null = parentId;
  for (let i = 0; cur && i < 50; i++) {
    const r: Row | null = await first<Row>(
      ctx.db,
      "SELECT id, parent_id FROM issues WHERE id = ? AND workspace_id = ?",
      cur,
      ctx.ws.id,
    );
    if (!r) fail("親課題が見つかりません", 404);
    if (r.parent_id === selfId) fail("循環する親子関係は設定できません");
    cur = r.parent_id;
  }
  return parentId;
}

function assertAdmin(ctx: MutationCtx) {
  if (ctx.role !== "admin") fail("この操作には管理者権限が必要です", 403);
}

// ---- 記録系ヘルパー ----
async function addActivity(ctx: MutationCtx, issueId: string, type: ActivityType, data: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  await run(
    ctx.db,
    "INSERT INTO activities (id, workspace_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    ctx.ws.id,
    issueId,
    ctx.user.id,
    type,
    JSON.stringify(data),
    ctx.now,
  );
  ctx.changes.push({
    entity: "activity",
    entityId: id,
    op: "upsert",
    data: { id, issueId, actorId: ctx.user.id, type, data, createdAt: ctx.now },
  });
}

async function addNotifications(
  ctx: MutationCtx,
  userIds: Iterable<string>,
  issueId: string,
  type: NotificationType,
  data: Record<string, unknown> = {},
) {
  const targets = [...new Set(userIds)].filter((u) => u && u !== ctx.user.id);
  for (const userId of targets) {
    const id = crypto.randomUUID();
    await run(
      ctx.db,
      `INSERT INTO notifications (id, workspace_id, user_id, issue_id, actor_id, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ctx.ws.id,
      userId,
      issueId,
      ctx.user.id,
      type,
      JSON.stringify(data),
      ctx.now,
    );
    ctx.changes.push({ entity: "notification", entityId: id, op: "upsert", userId });
  }
}

function touch(ctx: MutationCtx, entity: Change["entity"], entityId: string) {
  ctx.changes.push({ entity, entityId, op: "upsert" });
}

function stateTimestamps(type: StateType, row: Row, now: number) {
  switch (type) {
    case "started":
      return { started_at: row.started_at ?? now, completed_at: null, canceled_at: null };
    case "completed":
      return { started_at: row.started_at ?? now, completed_at: now, canceled_at: null };
    case "canceled":
      return { canceled_at: now, completed_at: null };
    default:
      return { started_at: null, completed_at: null, canceled_at: null };
  }
}

async function nextIssueNumber(ctx: MutationCtx, teamId: string): Promise<number> {
  const r = await first<{ issue_count: number }>(
    ctx.db,
    "UPDATE teams SET issue_count = issue_count + 1 WHERE id = ? RETURNING issue_count",
    teamId,
  );
  if (!r) fail("チームが見つかりません", 404);
  return r.issue_count;
}

async function defaultStateId(ctx: MutationCtx, teamId: string, type?: StateType): Promise<string> {
  const rows = await all<Row>(ctx.db, "SELECT * FROM workflow_states WHERE team_id = ? ORDER BY position", teamId);
  const pick = rows.find((s) => s.type === (type ?? "unstarted")) ?? rows.find((s) => s.type === "unstarted") ?? rows[0];
  if (!pick) fail("チームにステータスがありません");
  return pick.id;
}

function mentionedUserIds(text: string, members: Row[]): string[] {
  const ids: string[] = [];
  for (const m of members) {
    const names = [m.name, String(m.name).replace(/\s+/g, "")];
    if (names.some((n) => n && text.includes(`@${n}`))) ids.push(m.id);
  }
  return ids;
}

// ---- チーム作成（ワークスペース作成時にも使う） ----
export async function insertTeam(
  db: D1Database,
  workspaceId: string,
  team: { id: string; name: string; key: string; color: string },
  now: number,
): Promise<{ stateIds: Record<string, string> }> {
  const statements: D1PreparedStatement[] = [
    stmt(
      db,
      `INSERT INTO teams (id, workspace_id, name, key, color, issue_count, cycle_duration, cycles_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 2, 1, ?, ?)`,
      team.id,
      workspaceId,
      team.name,
      team.key,
      team.color,
      now,
      now,
    ),
  ];
  const stateIds: Record<string, string> = {};
  DEFAULT_STATES.forEach((s, i) => {
    const id = crypto.randomUUID();
    stateIds[s.name] = id;
    statements.push(
      stmt(
        db,
        `INSERT INTO workflow_states (id, workspace_id, team_id, name, type, color, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        workspaceId,
        team.id,
        s.name,
        s.type,
        s.color,
        i,
        now,
        now,
      ),
    );
  });
  await batch(db, statements);
  return { stateIds };
}

export function nextCycleDates(lastEnd: string | null, durationWeeks: number): { startsAt: string; endsAt: string } {
  const startsAt = lastEnd ? addDays(lastEnd, 1) : mondayOf(todayYmd());
  return { startsAt, endsAt: addDays(startsAt, durationWeeks * 7 - 1) };
}

// ---- 本体 ----
export async function applyMutation(ctx: MutationCtx, m: Mutation): Promise<void> {
  const { db, ws, user, now } = ctx;
  const a = (m.args ?? {}) as any;

  switch (m.type) {
    case "issue.create": {
      assertId(a.id);
      if (await first(db, "SELECT id FROM issues WHERE id = ?", a.id)) fail("ID が重複しています", 409);
      const team = await getTeam(ctx, a.teamId);
      const title = cleanText(a.title, 500, "タイトル");
      const stateId = a.stateId ? (await getState(ctx, a.stateId, team.id)).id : await defaultStateId(ctx, team.id);
      const state = await getState(ctx, stateId);
      const priority = Number.isInteger(a.priority) && a.priority >= 0 && a.priority <= 4 ? a.priority : 0;
      const assigneeId = a.assigneeId ? await assertMember(ctx, a.assigneeId) : null;
      const labelIds = a.labelIds ? await assertLabels(ctx, a.labelIds) : [];
      const projectId = a.projectId ? await assertProject(ctx, a.projectId) : null;
      const cycleId = a.cycleId ? await assertCycle(ctx, a.cycleId, team.id) : null;
      const parentId = a.parentId ? await assertParent(ctx, a.parentId, a.id) : null;
      const estimate = Number.isInteger(a.estimate) && a.estimate >= 0 && a.estimate <= 64 ? a.estimate : null;
      const dueDate = isValidYmd(a.dueDate) ? a.dueDate : null;
      let sortOrder = typeof a.sortOrder === "number" && Number.isFinite(a.sortOrder) ? a.sortOrder : null;
      if (sortOrder === null) {
        const r = await first<{ m: number | null }>(
          db,
          "SELECT MIN(sort_order) AS m FROM issues WHERE team_id = ? AND state_id = ?",
          team.id,
          stateId,
        );
        sortOrder = (r?.m ?? 0) - 1;
      }
      const number = await nextIssueNumber(ctx, team.id);
      const ts = stateTimestamps(state.type, {}, now);
      const subscribers = [...new Set([user.id, assigneeId].filter(Boolean))];
      await run(
        db,
        `INSERT INTO issues (id, workspace_id, team_id, number, title, description, state_id, priority, assignee_id, creator_id,
          project_id, cycle_id, parent_id, label_ids, subscriber_ids, estimate, due_date, sort_order, created_at, updated_at,
          started_at, completed_at, canceled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        ws.id,
        team.id,
        number,
        title,
        sanitizeHtml(a.description ?? ""),
        stateId,
        priority,
        assigneeId,
        user.id,
        projectId,
        cycleId,
        parentId,
        JSON.stringify(labelIds),
        JSON.stringify(subscribers),
        estimate,
        dueDate,
        sortOrder,
        now,
        now,
        (ts as Row).started_at ?? null,
        (ts as Row).completed_at ?? null,
        (ts as Row).canceled_at ?? null,
      );
      touch(ctx, "issue", a.id);
      await addActivity(ctx, a.id, "created");
      if (assigneeId) await addNotifications(ctx, [assigneeId], a.id, "assigned");
      return;
    }

    case "issue.update": {
      const row = await getIssue(ctx, a.id);
      const p = (a.patch ?? {}) as Row;
      const set: Row = {};
      const acts: [ActivityType, Record<string, unknown>][] = [];
      let teamId: string = row.team_id;
      let subscribers = parseJsonArray(row.subscriber_ids);
      const notify: [string[], NotificationType, Record<string, unknown>][] = [];

      if (p.teamId !== undefined && p.teamId !== row.team_id) {
        const team = await getTeam(ctx, p.teamId);
        const oldState = await getState(ctx, row.state_id);
        teamId = team.id;
        set.team_id = teamId;
        set.number = await nextIssueNumber(ctx, teamId);
        if (!p.stateId) set.state_id = await defaultStateId(ctx, teamId, oldState.type);
        if (!p.cycleId) set.cycle_id = null;
        acts.push(["team", { from: row.team_id, to: teamId }]);
      }
      if (p.title !== undefined) {
        const t = cleanText(p.title, 500, "タイトル");
        if (t !== row.title) {
          set.title = t;
          acts.push(["title", { from: row.title, to: t }]);
        }
      }
      if (p.description !== undefined) set.description = sanitizeHtml(p.description);
      if (p.stateId !== undefined || set.state_id) {
        const newStateId = p.stateId ?? set.state_id;
        const st = await getState(ctx, newStateId, teamId);
        if (st.id !== row.state_id) {
          set.state_id = st.id;
          Object.assign(set, stateTimestamps(st.type, row, now));
          acts.push(["state", { from: row.state_id, to: st.id }]);
          notify.push([subscribers, "state", { from: row.state_id, to: st.id }]);
        }
      }
      if (p.priority !== undefined) {
        if (!Number.isInteger(p.priority) || p.priority < 0 || p.priority > 4) fail("優先度が不正です");
        if (p.priority !== row.priority) {
          set.priority = p.priority;
          acts.push(["priority", { from: row.priority, to: p.priority }]);
        }
      }
      if (p.assigneeId !== undefined) {
        const next = p.assigneeId ? await assertMember(ctx, p.assigneeId) : null;
        if (next !== row.assignee_id) {
          set.assignee_id = next;
          acts.push(["assignee", { from: row.assignee_id, to: next }]);
          if (next) {
            subscribers = [...new Set([...subscribers, next])];
            notify.push([[next], "assigned", {}]);
          }
        }
      }
      if (p.labelIds !== undefined) {
        const next = await assertLabels(ctx, p.labelIds);
        const prev = parseJsonArray(row.label_ids);
        const added = next.filter((x) => !prev.includes(x));
        const removed = prev.filter((x) => !next.includes(x));
        if (added.length || removed.length) {
          set.label_ids = JSON.stringify(next);
          acts.push(["labels", { added, removed }]);
        }
      }
      if (p.projectId !== undefined) {
        const next = p.projectId ? await assertProject(ctx, p.projectId) : null;
        if (next !== row.project_id) {
          set.project_id = next;
          acts.push(["project", { from: row.project_id, to: next }]);
        }
      }
      if (p.cycleId !== undefined) {
        const next = p.cycleId ? await assertCycle(ctx, p.cycleId, teamId) : null;
        if (next !== row.cycle_id) {
          set.cycle_id = next;
          acts.push(["cycle", { from: row.cycle_id, to: next }]);
        }
      }
      if (p.parentId !== undefined) {
        const next = p.parentId ? await assertParent(ctx, p.parentId, row.id) : null;
        if (next !== row.parent_id) {
          set.parent_id = next;
          acts.push(["parent", { from: row.parent_id, to: next }]);
        }
      }
      if (p.estimate !== undefined) {
        const next = p.estimate === null ? null : Number(p.estimate);
        if (next !== null && (!Number.isInteger(next) || next < 0 || next > 64)) fail("見積もりが不正です");
        if (next !== row.estimate) {
          set.estimate = next;
          acts.push(["estimate", { from: row.estimate, to: next }]);
        }
      }
      if (p.dueDate !== undefined) {
        const next = p.dueDate === null ? null : isValidYmd(p.dueDate) ? p.dueDate : fail("期日が不正です");
        if (next !== row.due_date) {
          set.due_date = next;
          acts.push(["dueDate", { from: row.due_date, to: next }]);
        }
      }
      if (p.sortOrder !== undefined) {
        if (typeof p.sortOrder !== "number" || !Number.isFinite(p.sortOrder)) fail("並び順が不正です");
        set.sort_order = p.sortOrder;
      }
      if (p.subscriberIds !== undefined) {
        if (!Array.isArray(p.subscriberIds)) fail("購読者が不正です");
        const next: string[] = [];
        for (const u of new Set(p.subscriberIds as string[])) next.push(await assertMember(ctx, u));
        subscribers = next;
      }
      if (JSON.stringify(subscribers) !== row.subscriber_ids) set.subscriber_ids = JSON.stringify(subscribers);

      const cols = Object.keys(set);
      if (!cols.length) return;
      set.updated_at = now;
      const keys = Object.keys(set);
      await run(
        db,
        `UPDATE issues SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
        ...keys.map((k) => set[k]),
        row.id,
      );
      touch(ctx, "issue", row.id);
      for (const [type, data] of acts) await addActivity(ctx, row.id, type, data);
      for (const [targets, type, data] of notify) await addNotifications(ctx, targets, row.id, type, data);
      return;
    }

    case "issue.relate":
    case "issue.unrelate": {
      const row = await getIssue(ctx, a.id);
      const target = await getIssue(ctx, a.targetId);
      const type = a.type as RelationType;
      if (!RELATION_TYPES.includes(type)) fail("関係の種類が不正です");
      if (row.id === target.id) fail("自分自身とは関係を設定できません");
      const rels = parseRelations(row.relations);
      const tRels = parseRelations(target.relations);
      let nextRow: IssueRelation[];
      let nextTarget: IssueRelation[];
      if (m.type === "issue.relate") {
        // 同じ 2 つの課題の間の関係は 1 つだけ。種類を変えたときは置き換える
        nextRow = [...rels.filter((r) => r.issueId !== target.id), { type, issueId: target.id }];
        nextTarget = tRels.filter((r) => r.issueId !== row.id);
        if (nextRow.length > 200) fail("関係が多すぎます");
      } else {
        nextRow = rels.filter((r) => !(r.issueId === target.id && r.type === type));
        // 「関連」は向きがないので、相手側に保存されていても外す
        nextTarget = type === "related" ? tRels.filter((r) => !(r.issueId === row.id && r.type === "related")) : tRels;
      }
      const changedRow = JSON.stringify(nextRow) !== JSON.stringify(rels);
      const changedTarget = JSON.stringify(nextTarget) !== JSON.stringify(tRels);
      if (!changedRow && !changedTarget) return;
      if (changedRow) {
        await run(db, "UPDATE issues SET relations = ?, updated_at = ? WHERE id = ?", JSON.stringify(nextRow), now, row.id);
        touch(ctx, "issue", row.id);
      }
      if (changedTarget) {
        await run(db, "UPDATE issues SET relations = ?, updated_at = ? WHERE id = ?", JSON.stringify(nextTarget), now, target.id);
        touch(ctx, "issue", target.id);
      }
      const removed = m.type === "issue.unrelate";
      await addActivity(ctx, row.id, "relation", { relation: type, issueId: target.id, dir: "out", removed });
      await addActivity(ctx, target.id, "relation", { relation: type, issueId: row.id, dir: "in", removed });
      return;
    }

    case "issue.archive":
    case "issue.restore": {
      const row = await getIssue(ctx, a.id);
      const archived = m.type === "issue.archive";
      await run(db, "UPDATE issues SET archived_at = ?, updated_at = ? WHERE id = ?", archived ? now : null, now, row.id);
      touch(ctx, "issue", row.id);
      await addActivity(ctx, row.id, archived ? "archived" : "restored");
      return;
    }

    case "comment.create": {
      assertId(a.id);
      const issue = await getIssue(ctx, a.issueId);
      const body = sanitizeHtml(a.body, 100_000);
      const text = htmlToText(body);
      if (!text) fail("コメントを入力してください");
      await run(
        db,
        "INSERT INTO comments (id, workspace_id, issue_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        a.id,
        ws.id,
        issue.id,
        user.id,
        body,
        now,
        now,
      );
      touch(ctx, "comment", a.id);
      const members = await all<Row>(
        db,
        "SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ?",
        ws.id,
      );
      const mentioned = mentionedUserIds(text, members);
      const subscribers = parseJsonArray(issue.subscriber_ids);
      const nextSubs = [...new Set([...subscribers, user.id, ...mentioned])];
      if (nextSubs.length !== subscribers.length) {
        await run(db, "UPDATE issues SET subscriber_ids = ? WHERE id = ?", JSON.stringify(nextSubs), issue.id);
        touch(ctx, "issue", issue.id);
      }
      const snippet = text.slice(0, 140);
      await addNotifications(ctx, mentioned, issue.id, "mention", { commentId: a.id, snippet });
      await addNotifications(
        ctx,
        subscribers.filter((s) => !mentioned.includes(s)),
        issue.id,
        "comment",
        { commentId: a.id, snippet },
      );
      return;
    }

    case "comment.update": {
      assertId(a.id);
      const c = await first<Row>(db, "SELECT * FROM comments WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!c) fail("コメントが見つかりません", 404);
      if (c.user_id !== user.id) fail("自分のコメントのみ編集できます", 403);
      const body = sanitizeHtml(a.body, 100_000);
      if (!htmlToText(body)) fail("コメントを入力してください");
      await run(db, "UPDATE comments SET body = ?, updated_at = ?, edited_at = ? WHERE id = ?", body, now, now, a.id);
      touch(ctx, "comment", a.id);
      return;
    }

    case "comment.delete": {
      assertId(a.id);
      const c = await first<Row>(db, "SELECT * FROM comments WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!c) fail("コメントが見つかりません", 404);
      if (c.user_id !== user.id && ctx.role !== "admin") fail("このコメントは削除できません", 403);
      await run(db, "DELETE FROM comments WHERE id = ?", a.id);
      ctx.changes.push({ entity: "comment", entityId: a.id, op: "delete" });
      return;
    }

    case "label.create": {
      assertId(a.id);
      const name = cleanText(a.name, 40, "ラベル名");
      const color = COLOR.test(a.color) ? a.color : PALETTE[0];
      const dup = await first(db, "SELECT id FROM labels WHERE workspace_id = ? AND name = ?", ws.id, name);
      if (dup) fail("同じ名前のラベルがすでにあります", 409);
      await run(
        db,
        "INSERT INTO labels (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        a.id,
        ws.id,
        name,
        color,
        now,
        now,
      );
      touch(ctx, "label", a.id);
      return;
    }

    case "label.update": {
      assertId(a.id);
      const l = await first<Row>(db, "SELECT * FROM labels WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!l) fail("ラベルが見つかりません", 404);
      const name = a.name !== undefined ? cleanText(a.name, 40, "ラベル名") : l.name;
      const color = a.color !== undefined && COLOR.test(a.color) ? a.color : l.color;
      await run(db, "UPDATE labels SET name = ?, color = ?, updated_at = ? WHERE id = ?", name, color, now, a.id);
      touch(ctx, "label", a.id);
      return;
    }

    case "label.delete": {
      assertId(a.id);
      const l = await first<Row>(db, "SELECT * FROM labels WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!l) fail("ラベルが見つかりません", 404);
      const issues = await all<Row>(
        db,
        "SELECT id, label_ids FROM issues WHERE workspace_id = ? AND label_ids LIKE ?",
        ws.id,
        `%${a.id}%`,
      );
      for (const i of issues) {
        const next = parseJsonArray(i.label_ids).filter((x) => x !== a.id);
        await run(db, "UPDATE issues SET label_ids = ? WHERE id = ?", JSON.stringify(next), i.id);
        touch(ctx, "issue", i.id);
      }
      await run(db, "DELETE FROM labels WHERE id = ?", a.id);
      ctx.changes.push({ entity: "label", entityId: a.id, op: "delete" });
      return;
    }

    case "project.create": {
      assertId(a.id);
      const name = cleanText(a.name, 120, "プロジェクト名");
      const leadId = a.leadId ? await assertMember(ctx, a.leadId) : null;
      const teamIds: string[] = [];
      for (const t of Array.isArray(a.teamIds) ? a.teamIds : []) teamIds.push((await getTeam(ctx, t)).id);
      const r = await first<{ m: number | null }>(db, "SELECT MAX(sort_order) AS m FROM projects WHERE workspace_id = ?", ws.id);
      await run(
        db,
        `INSERT INTO projects (id, workspace_id, name, description, status, lead_id, team_ids, start_date, target_date, color, icon,
          sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        ws.id,
        name,
        sanitizeHtml(a.description ?? ""),
        ["backlog", "planned", "started", "paused", "completed", "canceled"].includes(a.status) ? a.status : "planned",
        leadId,
        JSON.stringify(teamIds),
        isValidYmd(a.startDate) ? a.startDate : null,
        isValidYmd(a.targetDate) ? a.targetDate : null,
        COLOR.test(a.color) ? a.color : PALETTE[Math.floor(Math.random() * PALETTE.length)],
        typeof a.icon === "string" ? a.icon.slice(0, 8) : null,
        (r?.m ?? 0) + 1,
        now,
        now,
      );
      touch(ctx, "project", a.id);
      return;
    }

    case "project.update": {
      assertId(a.id);
      const pr = await first<Row>(db, "SELECT * FROM projects WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!pr) fail("プロジェクトが見つかりません", 404);
      const p = (a.patch ?? {}) as Row;
      const set: Row = {};
      if (p.name !== undefined) set.name = cleanText(p.name, 120, "プロジェクト名");
      if (p.description !== undefined) set.description = sanitizeHtml(p.description);
      if (p.status !== undefined) {
        if (!["backlog", "planned", "started", "paused", "completed", "canceled"].includes(p.status)) fail("状態が不正です");
        set.status = p.status;
      }
      if (p.leadId !== undefined) set.lead_id = p.leadId ? await assertMember(ctx, p.leadId) : null;
      if (p.teamIds !== undefined) {
        const ids: string[] = [];
        for (const t of Array.isArray(p.teamIds) ? p.teamIds : []) ids.push((await getTeam(ctx, t)).id);
        set.team_ids = JSON.stringify(ids);
      }
      if (p.startDate !== undefined) set.start_date = p.startDate === null ? null : isValidYmd(p.startDate) ? p.startDate : fail("開始日が不正です");
      if (p.targetDate !== undefined) set.target_date = p.targetDate === null ? null : isValidYmd(p.targetDate) ? p.targetDate : fail("目標日が不正です");
      if (p.color !== undefined && COLOR.test(p.color)) set.color = p.color;
      if (p.icon !== undefined) set.icon = typeof p.icon === "string" ? p.icon.slice(0, 8) : null;
      if (p.sortOrder !== undefined && typeof p.sortOrder === "number") set.sort_order = p.sortOrder;
      if (!Object.keys(set).length) return;
      set.updated_at = now;
      const keys = Object.keys(set);
      await run(db, `UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => set[k]), a.id);
      touch(ctx, "project", a.id);
      return;
    }

    case "project.archive": {
      assertId(a.id);
      const pr = await first<Row>(db, "SELECT * FROM projects WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!pr) fail("プロジェクトが見つかりません", 404);
      const issues = await all<Row>(db, "SELECT id FROM issues WHERE project_id = ?", a.id);
      await run(db, "UPDATE issues SET project_id = NULL, updated_at = ? WHERE project_id = ?", now, a.id);
      issues.forEach((i) => touch(ctx, "issue", i.id));
      await run(db, "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, a.id);
      touch(ctx, "project", a.id);
      return;
    }

    case "cycle.create": {
      assertId(a.id);
      const team = await getTeam(ctx, a.teamId);
      const last = await first<Row>(
        db,
        "SELECT number, ends_at FROM cycles WHERE team_id = ? ORDER BY number DESC LIMIT 1",
        team.id,
      );
      const dates = nextCycleDates(last?.ends_at ?? null, team.cycle_duration);
      const startsAt = isValidYmd(a.startsAt) ? a.startsAt : dates.startsAt;
      const endsAt = isValidYmd(a.endsAt) ? a.endsAt : addDays(startsAt, team.cycle_duration * 7 - 1);
      if (endsAt < startsAt) fail("終了日は開始日以降にしてください");
      await run(
        db,
        `INSERT INTO cycles (id, workspace_id, team_id, number, name, starts_at, ends_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        ws.id,
        team.id,
        (last?.number ?? 0) + 1,
        typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 80) : null,
        startsAt,
        endsAt,
        now,
        now,
      );
      touch(ctx, "cycle", a.id);
      return;
    }

    case "cycle.update": {
      assertId(a.id);
      const cy = await first<Row>(db, "SELECT * FROM cycles WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!cy) fail("サイクルが見つかりません", 404);
      const p = (a.patch ?? {}) as Row;
      const name = p.name !== undefined ? (typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : null) : cy.name;
      const startsAt = p.startsAt !== undefined ? (isValidYmd(p.startsAt) ? p.startsAt : fail("開始日が不正です")) : cy.starts_at;
      const endsAt = p.endsAt !== undefined ? (isValidYmd(p.endsAt) ? p.endsAt : fail("終了日が不正です")) : cy.ends_at;
      if (endsAt < startsAt) fail("終了日は開始日以降にしてください");
      await run(db, "UPDATE cycles SET name = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?", name, startsAt, endsAt, now, a.id);
      touch(ctx, "cycle", a.id);
      return;
    }

    case "cycle.delete": {
      assertId(a.id);
      const cy = await first<Row>(db, "SELECT * FROM cycles WHERE id = ? AND workspace_id = ?", a.id, ws.id);
      if (!cy) fail("サイクルが見つかりません", 404);
      const issues = await all<Row>(db, "SELECT id FROM issues WHERE cycle_id = ?", a.id);
      await run(db, "UPDATE issues SET cycle_id = NULL, updated_at = ? WHERE cycle_id = ?", now, a.id);
      issues.forEach((i) => touch(ctx, "issue", i.id));
      await run(db, "DELETE FROM cycles WHERE id = ?", a.id);
      ctx.changes.push({ entity: "cycle", entityId: a.id, op: "delete" });
      return;
    }

    case "team.create": {
      assertId(a.id);
      const name = cleanText(a.name, 60, "チーム名");
      const key = String(a.key ?? "").toUpperCase().trim();
      if (!/^[A-Z][A-Z0-9]{0,6}$/.test(key)) fail("識別子は英大文字で始まる1〜7文字の英数字にしてください");
      if (await first(db, "SELECT id FROM teams WHERE workspace_id = ? AND key = ?", ws.id, key))
        fail("その識別子はすでに使われています", 409);
      const color = COLOR.test(a.color) ? a.color : PALETTE[Math.floor(Math.random() * PALETTE.length)];
      await insertTeam(db, ws.id, { id: a.id, name, key, color }, now);
      touch(ctx, "team", a.id);
      const states = await all<Row>(db, "SELECT id FROM workflow_states WHERE team_id = ?", a.id);
      states.forEach((s) => touch(ctx, "state", s.id));
      return;
    }

    case "team.update": {
      const team = await getTeam(ctx, a.id);
      const p = (a.patch ?? {}) as Row;
      const set: Row = {};
      if (p.name !== undefined) set.name = cleanText(p.name, 60, "チーム名");
      if (p.key !== undefined) {
        const key = String(p.key).toUpperCase().trim();
        if (!/^[A-Z][A-Z0-9]{0,6}$/.test(key)) fail("識別子は英大文字で始まる1〜7文字の英数字にしてください");
        if (key !== team.key && (await first(db, "SELECT id FROM teams WHERE workspace_id = ? AND key = ?", ws.id, key)))
          fail("その識別子はすでに使われています", 409);
        set.key = key;
      }
      if (p.color !== undefined && COLOR.test(p.color)) set.color = p.color;
      if (p.cycleDuration !== undefined) {
        const d = Number(p.cycleDuration);
        if (![1, 2, 3, 4].includes(d)) fail("サイクルの期間は1〜4週間です");
        set.cycle_duration = d;
      }
      if (p.cyclesEnabled !== undefined) set.cycles_enabled = p.cyclesEnabled ? 1 : 0;
      if (!Object.keys(set).length) return;
      set.updated_at = now;
      const keys = Object.keys(set);
      await run(db, `UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => set[k]), team.id);
      touch(ctx, "team", team.id);
      return;
    }

    case "state.create": {
      assertId(a.id);
      const team = await getTeam(ctx, a.teamId);
      const name = cleanText(a.name, 40, "ステータス名");
      if (!STATE_TYPES.includes(a.type)) fail("種類が不正です");
      const r = await first<{ m: number | null }>(
        db,
        "SELECT MAX(position) AS m FROM workflow_states WHERE team_id = ? AND type = ?",
        team.id,
        a.type,
      );
      const base = STATE_TYPES.indexOf(a.type) * 100;
      await run(
        db,
        `INSERT INTO workflow_states (id, workspace_id, team_id, name, type, color, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        ws.id,
        team.id,
        name,
        a.type,
        COLOR.test(a.color) ? a.color : "#8b8d93",
        r?.m != null ? r.m + 0.5 : base,
        now,
        now,
      );
      touch(ctx, "state", a.id);
      return;
    }

    case "state.update": {
      const st = await getState(ctx, a.id);
      const p = (a.patch ?? {}) as Row;
      const name = p.name !== undefined ? cleanText(p.name, 40, "ステータス名") : st.name;
      const color = p.color !== undefined && COLOR.test(p.color) ? p.color : st.color;
      const position = typeof p.position === "number" ? p.position : st.position;
      await run(
        db,
        "UPDATE workflow_states SET name = ?, color = ?, position = ?, updated_at = ? WHERE id = ?",
        name,
        color,
        position,
        now,
        st.id,
      );
      touch(ctx, "state", st.id);
      return;
    }

    case "state.delete": {
      const st = await getState(ctx, a.id);
      const target = await getState(ctx, a.moveToStateId, st.team_id);
      if (target.id === st.id) fail("移動先のステータスを選んでください");
      const sameType = await first<{ c: number }>(
        db,
        "SELECT COUNT(*) AS c FROM workflow_states WHERE team_id = ? AND type = ?",
        st.team_id,
        st.type,
      );
      if ((sameType?.c ?? 0) <= 1) fail("この種類の最後のステータスは削除できません");
      const issues = await all<Row>(db, "SELECT id FROM issues WHERE state_id = ?", st.id);
      await run(db, "UPDATE issues SET state_id = ?, updated_at = ? WHERE state_id = ?", target.id, now, st.id);
      issues.forEach((i) => touch(ctx, "issue", i.id));
      await run(db, "DELETE FROM workflow_states WHERE id = ?", st.id);
      ctx.changes.push({ entity: "state", entityId: st.id, op: "delete" });
      return;
    }

    case "notification.update": {
      assertId(a.id);
      const n = await first<Row>(
        db,
        "SELECT * FROM notifications WHERE id = ? AND workspace_id = ? AND user_id = ?",
        a.id,
        ws.id,
        user.id,
      );
      if (!n) fail("通知が見つかりません", 404);
      const p = (a.patch ?? {}) as Row;
      const num = (v: unknown, cur: unknown) => (v === undefined ? cur : v === null ? null : Number(v));
      await run(
        db,
        "UPDATE notifications SET read_at = ?, archived_at = ?, snoozed_until = ? WHERE id = ?",
        num(p.readAt, n.read_at) as number | null,
        num(p.archivedAt, n.archived_at) as number | null,
        num(p.snoozedUntil, n.snoozed_until) as number | null,
        a.id,
      );
      ctx.changes.push({ entity: "notification", entityId: a.id, op: "upsert", userId: user.id });
      return;
    }

    case "notification.markAllRead": {
      const rows = await all<Row>(
        db,
        "SELECT id FROM notifications WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL AND archived_at IS NULL",
        ws.id,
        user.id,
      );
      await run(
        db,
        "UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND user_id = ? AND read_at IS NULL",
        now,
        ws.id,
        user.id,
      );
      rows.forEach((r) => ctx.changes.push({ entity: "notification", entityId: r.id, op: "upsert", userId: user.id }));
      return;
    }

    case "workspace.update": {
      assertAdmin(ctx);
      const name = cleanText(a.name, 60, "ワークスペース名");
      await run(db, "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?", name, now, ws.id);
      touch(ctx, "workspace", ws.id);
      return;
    }

    case "workspace.regenerateInvite": {
      assertAdmin(ctx);
      await run(db, "UPDATE workspaces SET invite_code = ?, updated_at = ? WHERE id = ?", randomToken(12), now, ws.id);
      touch(ctx, "workspace", ws.id);
      return;
    }

    case "user.update": {
      const cur = await first<Row>(db, "SELECT * FROM users WHERE id = ?", user.id);
      if (!cur) fail("ユーザーが見つかりません", 404);
      const name = a.name !== undefined ? cleanText(a.name, 40, "名前") : cur.name;
      const color = a.avatarColor !== undefined && COLOR.test(a.avatarColor) ? a.avatarColor : cur.avatar_color;
      let settings = cur.settings;
      if (a.settings !== undefined) {
        const s = JSON.stringify(a.settings ?? {});
        if (s.length > 20_000) fail("設定が大きすぎます");
        settings = s;
      }
      await run(
        db,
        "UPDATE users SET name = ?, avatar_color = ?, settings = ?, updated_at = ? WHERE id = ?",
        name,
        color,
        settings,
        now,
        user.id,
      );
      touch(ctx, "user", user.id);
      ctx.changes.push({
        entity: "user",
        entityId: user.id,
        op: "upsert",
        userId: user.id,
        data: {
          id: user.id,
          name,
          email: cur.email,
          avatarColor: color,
          role: ctx.role,
          createdAt: cur.created_at,
          settings: JSON.parse(settings || "{}"),
        },
      });
      return;
    }

    case "member.update": {
      assertAdmin(ctx);
      const uid = await assertMember(ctx, a.userId);
      if (!["admin", "member"].includes(a.role)) fail("権限が不正です");
      if (uid === user.id && a.role !== "admin") {
        const admins = await first<{ c: number }>(
          db,
          "SELECT COUNT(*) AS c FROM members WHERE workspace_id = ? AND role = 'admin'",
          ws.id,
        );
        if ((admins?.c ?? 0) <= 1) fail("管理者が1人もいなくなるため変更できません");
      }
      await run(db, "UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?", a.role, ws.id, uid);
      touch(ctx, "user", uid);
      return;
    }

    case "member.remove": {
      assertAdmin(ctx);
      const uid = await assertMember(ctx, a.userId);
      if (uid === user.id) fail("自分自身は削除できません");
      await run(db, "DELETE FROM members WHERE workspace_id = ? AND user_id = ?", ws.id, uid);
      const assigned = await all<Row>(
        db,
        "SELECT id FROM issues WHERE workspace_id = ? AND assignee_id = ?",
        ws.id,
        uid,
      );
      await run(db, "UPDATE issues SET assignee_id = NULL, updated_at = ? WHERE workspace_id = ? AND assignee_id = ?", now, ws.id, uid);
      assigned.forEach((i) => touch(ctx, "issue", i.id));
      ctx.changes.push({ entity: "user", entityId: uid, op: "delete" });
      return;
    }

    default:
      fail(`不明な操作です: ${(m as { type: string }).type}`);
  }
}

export function randomAvatarColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}
