// MCP のツール定義。書き込みは applyMutation だけを通す（検証・履歴・通知・権限はそちらに任せる）。

import { PRIORITY_ORDER } from "../../shared/constants";
import { fuzzyMatch } from "../../shared/text";
import type { ApiTokenScope, IssuePatch, Mutation } from "../../shared/types";
import { applyMutation, htmlToText, type MutationCtx } from "../mutations";
import { htmlToMarkdown, markdownToHtml } from "../markdown";
import {
  cycleLabel,
  isCleared,
  parseDueDate,
  parseEstimate,
  priorityShort,
  ToolError,
  type IssueRow,
  type Resolver,
  type StatusMatch,
  type TeamSnap,
} from "./context";

export const READ_ONLY_MESSAGE =
  "このトークンは閲覧のみです。課題を変更するには、Sen の 設定 → AI 連携 で「課題の作成と変更」ができるトークンを発行してください。";

const MAX_BATCH = 50;

export interface ToolContext {
  resolver: Resolver;
  mutation: MutationCtx;
  scope: ApiTokenScope;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  handle(ctx: ToolContext, args: unknown): Promise<unknown>;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

type CreateArgs = Extract<Mutation, { type: "issue.create" }>["args"];

function asObject(v: unknown, label = "入力"): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolError(`${label}はオブジェクトで指定してください`);
  return v as Record<string, unknown>;
}

function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ToolError(`不明な項目「${key}」は使えません`);
  }
}

function asBool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw new ToolError(`${label}は true か false で指定してください`);
  return v;
}

function asStringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ToolError(`${label}は文字列の配列で指定してください`);
  return v;
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function idsOf(v: string | null | undefined): string[] {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((id, i) => id === bs[i]);
}

function titleHint(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const chars = [...t];
  const shown = chars.slice(0, 40).join("");
  return `「${shown}${chars.length > 40 ? "…" : ""}」`;
}

function cleanTitle(v: unknown): string {
  if (typeof v !== "string") throw new ToolError("タイトルは文字列で指定してください");
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!t) throw new ToolError("タイトルを入力してください");
  if (t.length > 500) throw new ToolError("タイトルは500文字以内で入力してください");
  return t;
}

function markdownHtml(v: unknown, label: string): string {
  if (typeof v !== "string") throw new ToolError(`${label}は Markdown の文字列で指定してください`);
  const html = markdownToHtml(v);
  if (html.length > 200_000) throw new ToolError("本文が長すぎます");
  return html;
}

async function mutate(ctx: ToolContext, m: Mutation): Promise<void> {
  ctx.mutation.now = Date.now();
  await applyMutation(ctx.mutation, m);
}

function labelChange(resolver: Resolver, added: string[], removed: string[]): string {
  const parts = [...resolver.labelNames(added).map((n) => `+${n}`), ...resolver.labelNames(removed).map((n) => `−${n}`)];
  return `ラベル：${parts.join(" ")}`;
}

const str = (description: string) => ({ type: "string", description });
const strNull = (description: string) => ({ type: ["string", "null"], description });

const fieldProps = {
  description: str("説明（Markdown）。見出し・箇条書き・チェックリスト・コード・リンクが使えます。表と画像は使えません"),
  status: str("ステータスの名前（例: 進行中）または種類（未着手、started、done、キャンセルなど）。省略すると未着手"),
  priority: {
    type: ["integer", "string"],
    description: "優先度。0〜4 の整数、または なし / 緊急 / 高 / 中 / 低（0 と なし は優先度なし）",
  },
  assignee: strNull("担当者の名前かメールアドレス。「me」「自分」「私」で自分。null、「none」、「なし」で担当者なし"),
  labels: {
    type: "array",
    items: { type: "string" },
    description: "ラベル名の配列。指定すると、今のラベルをこの内容で置き換えます",
  },
  project: strNull("プロジェクト名。null、「none」、「なし」で外す"),
  cycle: {
    type: ["string", "integer", "null"],
    description: "サイクル。「current」「今」「next」「次」、番号、名前のいずれか。null、「none」、「なし」で外す",
  },
  estimate: { type: ["integer", "null"], description: "見積もり（0〜64 の整数）。null で外す" },
  dueDate: strNull("期日（YYYY-MM-DD）。null で外す"),
  parent: strNull("親課題の ID（例: ENG-10）、課題の URL、または UUID。null で外す"),
};

const subIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  description: "サブ課題。team を省略すると親のチーム、project を省略すると親のプロジェクトになります",
  properties: {
    team: str("チームのキーまたは名前。省略すると親課題のチーム"),
    title: str("タイトル（1〜500文字）"),
    ...fieldProps,
  },
};

const createIssueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    team: str("チームのキー（例: ENG）または名前。parent を指定したときは省略でき、親課題のチームになります"),
    title: str("タイトル（1〜500文字）"),
    ...fieldProps,
    subIssues: {
      type: "array",
      items: subIssueSchema,
      description: "この課題のサブ課題。サブ課題の中にさらにサブ課題は作れません。合計 50 件まで",
    },
  },
};

// ---- 読み取り ----

async function getWorkspace(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {});
  rejectUnknown(raw, []);
  return ctx.resolver.workspaceView(ctx.scope);
}

const SEARCH_KEYS = [
  "query",
  "team",
  "status",
  "assignee",
  "labels",
  "project",
  "cycle",
  "priority",
  "parent",
  "includeClosed",
  "sort",
  "limit",
] as const;

async function searchIssues(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {});
  rejectUnknown(raw, SEARCH_KEYS);
  const resolver = ctx.resolver;
  if (present(raw.query) && typeof raw.query !== "string") throw new ToolError("query は文字列で指定してください");
  const query = typeof raw.query === "string" ? raw.query : "";

  let team: TeamSnap | undefined;
  if (present(raw.team)) team = resolver.resolveTeam(raw.team);

  let statusFilters: StatusMatch[] | undefined;
  if (present(raw.status)) {
    const values = asStringArray(raw.status, "status");
    if (values.length) statusFilters = values.map((v) => resolver.resolveStatusFilter(v, team));
  }

  let assignee: "none" | string | undefined;
  if (present(raw.assignee)) {
    if (typeof raw.assignee !== "string") throw new ToolError("assignee は文字列で指定してください");
    assignee = isCleared(raw.assignee) ? "none" : resolver.resolveUser(raw.assignee).id;
  }

  let labelIds: string[] | undefined;
  if (present(raw.labels)) {
    const names = asStringArray(raw.labels, "labels");
    if (names.length) labelIds = resolver.resolveLabels(names);
  }

  let project: "none" | string | undefined;
  if (present(raw.project)) {
    if (typeof raw.project !== "string") throw new ToolError("project は文字列で指定してください");
    project = isCleared(raw.project) ? "none" : resolver.resolveProject(raw.project).id;
  }

  let cycle: "none" | Set<string> | undefined;
  if (present(raw.cycle)) cycle = resolver.resolveCycleFilter(raw.cycle, team);

  let priorities: number[] | undefined;
  if (present(raw.priority)) {
    if (!Array.isArray(raw.priority)) throw new ToolError("priority は配列で指定してください");
    if (raw.priority.length) priorities = raw.priority.map((v) => resolver.resolvePriority(v));
  }

  let parentId: string | undefined;
  if (present(raw.parent)) parentId = (await resolver.resolveIssue(raw.parent)).id;

  const includeClosed = present(raw.includeClosed) ? asBool(raw.includeClosed, "includeClosed") : false;
  const sort = present(raw.sort) ? asSort(raw.sort) : "updated";
  const limit = present(raw.limit) ? asLimit(raw.limit) : 50;

  const rows = await resolver.loadIssues();
  const byId = new Map(rows.map((r) => [r.id, r]));
  let list = rows.filter((r) => r.archived_at == null);
  if (query.trim()) {
    list = list.filter((r) => fuzzyMatch(`${resolver.ident(r)}\n${r.title}\n${htmlToText(r.description ?? "")}`, query));
  }
  if (team) list = list.filter((r) => r.team_id === team.id);
  if (statusFilters) list = list.filter((r) => resolver.matchesStatus(r.state_id, statusFilters));
  else if (!includeClosed) list = list.filter((r) => !resolver.isClosed(r.state_id));
  if (assignee === "none") list = list.filter((r) => !r.assignee_id);
  else if (assignee) list = list.filter((r) => r.assignee_id === assignee);
  if (labelIds) list = list.filter((r) => idsOf(r.label_ids).some((id) => labelIds.includes(id)));
  if (project === "none") list = list.filter((r) => !r.project_id);
  else if (project) list = list.filter((r) => r.project_id === project);
  if (cycle === "none") list = list.filter((r) => !r.cycle_id);
  else if (cycle) list = list.filter((r) => r.cycle_id != null && cycle.has(r.cycle_id));
  if (priorities) list = list.filter((r) => priorities.includes(r.priority));
  if (parentId) list = list.filter((r) => r.parent_id === parentId);

  if (sort === "created") list.sort((a, b) => b.created_at - a.created_at);
  else if (sort === "priority") {
    list.sort((a, b) => {
      const d = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
      return d || b.updated_at - a.updated_at;
    });
  } else list.sort((a, b) => b.updated_at - a.updated_at);

  const total = list.length;
  const issues = list.slice(0, limit).map((r) => resolver.summarize(r, byId));
  const result: Record<string, unknown> = { total, issues };
  if (total > issues.length) {
    result.note = `ほかに ${total - issues.length} 件あります。条件を絞り込むか limit を増やしてください`;
  }
  return result;
}

function asSort(v: unknown): "updated" | "created" | "priority" {
  if (v === "updated" || v === "created" || v === "priority") return v;
  throw new ToolError("sort は updated、created、priority のいずれかです");
}

function asLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 200) {
    throw new ToolError("limit は 1〜200 の整数で指定してください");
  }
  return v;
}

async function getIssue(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {}, "入力");
  rejectUnknown(raw, ["issue"]);
  if (typeof raw.issue !== "string") throw new ToolError("課題は「ENG-12」の形式で指定してください");
  const resolver = ctx.resolver;
  const row = await resolver.resolveIssue(raw.issue);
  const parents = new Map<string, IssueRow>();
  if (row.parent_id) {
    const parent = await resolver.issueById(row.parent_id);
    if (parent) parents.set(parent.id, parent);
  }
  const detail: Record<string, unknown> = {
    ...resolver.summarize(row, parents),
    description: htmlToMarkdown(row.description ?? ""),
    creator: await resolver.userName(row.creator_id),
    createdAt: new Date(row.created_at).toISOString(),
    branchName: resolver.branchName(row),
  };
  const subs = await resolver.childrenOf(row.id);
  if (subs.length) {
    detail.subIssues = subs.map((s) => ({ id: resolver.ident(s), title: s.title, status: resolver.stateName(s.state_id) }));
  }
  const relations = await resolver.relationsOf(row);
  if (relations) detail.relations = relations;
  const comments = await resolver.commentsOf(row.id);
  if (comments.comments.length) detail.comments = comments.comments;
  if (comments.note) detail.commentsNote = comments.note;
  if (row.archived_at != null) detail.archived = true;
  return detail;
}

// ---- 作成 ----

const CREATE_KEYS = ["team", "title", "description", "status", "priority", "assignee", "labels", "project", "cycle", "estimate", "dueDate", "parent", "subIssues"];

interface ProjectMode {
  kind: "omit" | "none" | "id";
  id?: string;
}

interface ResolvedCreate {
  title: string;
  team: TeamSnap;
  state: { id: string; name: string };
  description?: string;
  priority?: number;
  assigneeId?: string;
  labelIds?: string[];
  projectId?: string;
  cycleId?: string;
  estimate?: number;
  dueDate?: string;
  parentId?: string;
  useEnclosingParent: boolean;
  children: ResolvedCreate[];
}

interface Inherited {
  enclosing: boolean;
  team?: TeamSnap;
  project: ProjectMode;
}

function catchField(errors: string[], where: string, e: unknown) {
  if (!(e instanceof ToolError)) throw e;
  errors.push(`${where}：${e.message}`);
}

async function resolveCreateItem(
  resolver: Resolver,
  raw: unknown,
  where: string,
  errors: string[],
  inherited?: Inherited,
): Promise<ResolvedCreate | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${where}：課題はオブジェクトで指定してください`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  let failed = false;
  const fail = (field: string, e: unknown) => {
    failed = true;
    catchField(errors, `${where}の${field}`, e);
  };

  if (inherited?.enclosing && "subIssues" in obj) {
    fail("サブ課題", new ToolError("サブ課題の中にさらにサブ課題は作れません"));
  }
  for (const key of Object.keys(obj)) {
    if (key === "subIssues" && inherited?.enclosing) continue;
    if (!CREATE_KEYS.includes(key)) fail(key, new ToolError(`不明な項目「${key}」は使えません`));
  }

  let title = "";
  if (!("title" in obj)) fail("タイトル", new ToolError("タイトルを入力してください"));
  else {
    try {
      title = cleanTitle(obj.title);
    } catch (e) {
      fail("タイトル", e);
    }
  }

  let description: string | undefined;
  if ("description" in obj && obj.description !== undefined && obj.description !== null) {
    try {
      const html = markdownHtml(obj.description, "説明");
      if (html) description = html;
    } catch (e) {
      fail("説明", e);
    }
  }

  let parentId: string | undefined;
  let useEnclosingParent = !!inherited?.enclosing;
  let team: TeamSnap | undefined;
  let teamFailed = false;

  if ("team" in obj && obj.team !== undefined) {
    try {
      team = resolver.resolveTeam(obj.team);
    } catch (e) {
      teamFailed = true;
      fail("チーム", e);
    }
  }

  if ("parent" in obj && obj.parent !== undefined) {
    if (isCleared(obj.parent)) useEnclosingParent = false;
    else {
      try {
        const parent = await resolver.resolveIssue(obj.parent);
        if (parent.archived_at != null) throw new ToolError(`${resolver.ident(parent)} は削除されています`);
        await resolver.assertCanParent(parent.id, crypto.randomUUID());
        parentId = parent.id;
        useEnclosingParent = false;
        if (!team && !teamFailed) {
          team = resolver.snap.teamById.get(parent.team_id);
          if (!team) throw new ToolError("親課題のチームが見つかりません");
        }
      } catch (e) {
        fail("親課題", e);
      }
    }
  }

  if (!team && !teamFailed && inherited?.team) team = inherited.team;
  if (!team && !teamFailed) fail("チーム", new ToolError("チームを指定してください。親課題を指定したときは省略できます"));

  let state: { id: string; name: string } | undefined;
  if (team && "status" in obj && obj.status !== undefined) {
    try {
      const st = resolver.resolveState(team, obj.status);
      state = { id: st.id, name: st.name };
    } catch (e) {
      fail("ステータス", e);
    }
  } else if (team) {
    const st = resolver.defaultState(team);
    if (!st) fail("ステータス", new ToolError("チームにステータスがありません"));
    else state = { id: st.id, name: st.name };
  }

  let priority: number | undefined;
  if ("priority" in obj && obj.priority !== undefined) {
    try {
      priority = resolver.resolvePriority(obj.priority);
    } catch (e) {
      fail("優先度", e);
    }
  }

  let assigneeId: string | undefined;
  if ("assignee" in obj && obj.assignee !== undefined && !isCleared(obj.assignee)) {
    try {
      assigneeId = resolver.resolveUser(obj.assignee).id;
    } catch (e) {
      fail("担当者", e);
    }
  }

  let labelIds: string[] | undefined;
  if ("labels" in obj && obj.labels !== undefined) {
    try {
      const ids = resolver.resolveLabels(obj.labels);
      if (ids.length) labelIds = ids;
    } catch (e) {
      fail("ラベル", e);
    }
  }

  let project: ProjectMode = inherited?.project ?? { kind: "omit" };
  if ("project" in obj) {
    if (obj.project === undefined || isCleared(obj.project)) project = { kind: "none" };
    else {
      try {
        project = { kind: "id", id: resolver.resolveProject(obj.project).id };
      } catch (e) {
        fail("プロジェクト", e);
        project = { kind: "omit" };
      }
    }
  }

  let cycleId: string | undefined;
  if (team && "cycle" in obj && obj.cycle !== undefined && !isCleared(obj.cycle)) {
    try {
      cycleId = resolver.resolveCycle(team, obj.cycle).id;
    } catch (e) {
      fail("サイクル", e);
    }
  }

  let estimate: number | undefined;
  if ("estimate" in obj && obj.estimate !== undefined && !isCleared(obj.estimate)) {
    try {
      estimate = parseEstimate(obj.estimate);
    } catch (e) {
      fail("見積もり", e);
    }
  }

  let dueDate: string | undefined;
  if ("dueDate" in obj && obj.dueDate !== undefined && !isCleared(obj.dueDate)) {
    try {
      dueDate = parseDueDate(obj.dueDate);
    } catch (e) {
      fail("期日", e);
    }
  }

  const children: ResolvedCreate[] = [];
  if (!inherited?.enclosing && "subIssues" in obj && obj.subIssues !== undefined) {
    if (!Array.isArray(obj.subIssues)) fail("サブ課題", new ToolError("サブ課題は配列で指定してください"));
    else {
      for (let i = 0; i < obj.subIssues.length; i++) {
        const childWhere = `${where}のサブ課題 ${i + 1}件目${titleHint(isObject(obj.subIssues[i]) ? obj.subIssues[i].title : undefined)}`;
        const child = await resolveCreateItem(resolver, obj.subIssues[i], childWhere, errors, {
          enclosing: true,
          team,
          project,
        });
        if (child) children.push(child);
        else failed = true;
      }
    }
  }

  if (failed || !title || !team || !state) return null;
  return {
    title,
    team,
    state,
    description,
    priority,
    assigneeId,
    labelIds,
    projectId: project.kind === "id" ? project.id : undefined,
    cycleId,
    estimate,
    dueDate,
    parentId,
    useEnclosingParent,
    children,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

interface Plan {
  uuid: string;
  title: string;
  teamKey: string;
  stateName: string;
  teamId: string;
  stateId: string;
  args: CreateArgs;
  children: Plan[];
}

function toPlan(item: ResolvedCreate, enclosingId?: string): Plan {
  const uuid = crypto.randomUUID();
  const args: CreateArgs = { id: uuid, teamId: item.team.id, title: item.title, stateId: item.state.id };
  if (item.description) args.description = item.description;
  if (item.priority !== undefined) args.priority = item.priority;
  if (item.assigneeId) args.assigneeId = item.assigneeId;
  if (item.labelIds) args.labelIds = item.labelIds;
  if (item.projectId) args.projectId = item.projectId;
  if (item.cycleId) args.cycleId = item.cycleId;
  if (item.estimate !== undefined) args.estimate = item.estimate;
  if (item.dueDate) args.dueDate = item.dueDate;
  if (item.parentId) args.parentId = item.parentId;
  else if (item.useEnclosingParent && enclosingId) args.parentId = enclosingId;
  return {
    uuid,
    title: item.title,
    teamKey: item.team.key,
    stateName: item.state.name,
    teamId: item.team.id,
    stateId: item.state.id,
    args,
    children: item.children.map((child) => toPlan(child, uuid)),
  };
}

function flattenPlans(plans: Plan[]): Plan[] {
  const out: Plan[] = [];
  const walk = (p: Plan) => {
    out.push(p);
    p.children.forEach(walk);
  };
  plans.forEach(walk);
  return out;
}

function countCreate(issues: unknown[]): number {
  let n = 0;
  for (const item of issues) {
    n += 1;
    if (isObject(item) && Array.isArray(item.subIssues)) n += item.subIssues.length;
  }
  return n;
}

async function createIssues(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {});
  rejectUnknown(raw, ["issues"]);
  if (!Array.isArray(raw.issues)) throw new ToolError("issues は配列で指定してください");
  if (!raw.issues.length) throw new ToolError("作成する課題を 1 件以上指定してください");
  if (countCreate(raw.issues) > MAX_BATCH) throw new ToolError("一度に作成できる課題は、サブ課題を含めて 50 件までです");

  const errors: string[] = [];
  const resolved: ResolvedCreate[] = [];
  for (let i = 0; i < raw.issues.length; i++) {
    const item = raw.issues[i];
    const where = `${i + 1}件目の課題${titleHint(isObject(item) ? item.title : undefined)}`;
    const before = errors.length;
    const one = await resolveCreateItem(ctx.resolver, item, where, errors);
    if (one && errors.length === before) resolved.push(one);
  }
  if (errors.length) throw new ToolError(errors.join("\n"));

  const plans = resolved.map((item) => toPlan(item));
  const flat = flattenPlans(plans);
  // 同じチーム・ステータスに入る課題は、今の先頭より上に、指定順で並ぶよう sortOrder を振る
  const groups = new Map<string, Plan[]>();
  for (const plan of flat) {
    const key = `${plan.teamId}\0${plan.stateId}`;
    const list = groups.get(key);
    if (list) list.push(plan);
    else groups.set(key, [plan]);
  }
  for (const list of groups.values()) {
    const minRaw = await ctx.resolver.minSort(list[0].teamId, list[0].stateId);
    const min = minRaw == null || !Number.isFinite(Number(minRaw)) ? 0 : Number(minRaw);
    const start = min - list.length;
    list.forEach((plan, i) => {
      plan.args.sortOrder = start + i;
    });
  }
  for (const plan of flat) {
    await mutate(ctx, { type: "issue.create", args: plan.args });
  }
  const numbers = await ctx.resolver.issueNumbers(flat.map((p) => p.uuid));
  const created = plans.map((plan) => createdNode(ctx.resolver, plan, numbers));
  return { summary: `${flat.length}件の課題を作成しました`, created };
}

function createdNode(resolver: Resolver, plan: Plan, numbers: Map<string, number>): Record<string, unknown> {
  const ident = `${plan.teamKey}-${numbers.get(plan.uuid) ?? "?"}`;
  const node: Record<string, unknown> = {
    id: ident,
    title: plan.title,
    status: plan.stateName,
    url: resolver.issueUrl(ident),
  };
  if (plan.children.length) {
    node.subIssues = plan.children.map((child) => {
      const id = `${child.teamKey}-${numbers.get(child.uuid) ?? "?"}`;
      return { id, title: child.title, url: resolver.issueUrl(id) };
    });
  }
  return node;
}

// ---- 更新 ----

const UPDATE_KEYS = [
  "issue",
  "team",
  "title",
  "description",
  "status",
  "priority",
  "assignee",
  "labels",
  "addLabels",
  "removeLabels",
  "project",
  "cycle",
  "estimate",
  "dueDate",
  "parent",
];

interface UpdatePlan {
  row: IssueRow;
  ident: string;
  patch: IssuePatch;
  changes: string[];
}

async function planUpdate(resolver: Resolver, raw: unknown, index: number, errors: string[], seen: Set<string>): Promise<UpdatePlan | "unchanged" | null> {
  const where = `${index + 1}件目`;
  if (!isObject(raw)) {
    errors.push(`${where}の課題：課題はオブジェクトで指定してください`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!UPDATE_KEYS.includes(key)) errors.push(`${where}の課題：不明な項目「${key}」は使えません`);
  }
  if (typeof raw.issue !== "string") {
    errors.push(`${where}の課題：課題は「ENG-12」の形式で指定してください`);
    return null;
  }
  let row: IssueRow;
  try {
    row = await resolver.resolveIssue(raw.issue);
  } catch (e) {
    catchField(errors, `${where}の課題`, e);
    return null;
  }
  const ident = resolver.ident(row);
  if (row.archived_at != null) {
    errors.push(`${where}の課題：${ident} は削除されています`);
    return null;
  }
  if (seen.has(row.id)) {
    errors.push(`${where}の課題：課題「${ident}」が複数回指定されています。1 件にまとめてください`);
    return null;
  }
  seen.add(row.id);

  const patch: IssuePatch = {};
  const changes: string[] = [];
  let failed = false;
  const fail = (field: string, e: unknown) => {
    failed = true;
    catchField(errors, `${index + 1}件目の課題「${ident}」の${field}`, e);
  };

  const currentTeam = resolver.snap.teamById.get(row.team_id);
  let team = currentTeam;
  let teamFailed = false;
  let moving = false;
  if ("team" in raw && raw.team !== undefined) {
    try {
      const next = resolver.resolveTeam(raw.team);
      if (!currentTeam || next.id !== currentTeam.id) {
        team = next;
        moving = true;
        patch.teamId = next.id;
        changes.push(`チーム：${currentTeam?.key ?? "?"} → ${next.key}`);
      }
    } catch (e) {
      teamFailed = true;
      fail("チーム", e);
    }
  }

  if ("title" in raw && raw.title !== undefined) {
    try {
      const title = cleanTitle(raw.title);
      if (title !== row.title) {
        patch.title = title;
        changes.push(`タイトル：${row.title} → ${title}`);
      }
    } catch (e) {
      fail("タイトル", e);
    }
  }

  if ("description" in raw && raw.description !== undefined) {
    try {
      const html = raw.description === null ? "" : markdownHtml(raw.description, "説明");
      if (html !== (row.description ?? "")) {
        patch.description = html;
        changes.push("説明を更新");
      }
    } catch (e) {
      fail("説明", e);
    }
  }

  if (team && !teamFailed && "status" in raw && raw.status !== undefined) {
    try {
      const st = resolver.resolveState(team, raw.status);
      if (st.id !== row.state_id) {
        patch.stateId = st.id;
        const oldName = resolver.stateName(row.state_id);
        changes.push(st.name === oldName ? "ステータスを更新" : `ステータス：${oldName} → ${st.name}`);
      }
    } catch (e) {
      fail("ステータス", e);
    }
  } else if (moving && team) {
    const old = resolver.snap.stateById.get(row.state_id);
    const next = old ? resolver.stateForType(team, old.type) : resolver.defaultState(team);
    if (!next) fail("ステータス", new ToolError("チームにステータスがありません"));
    else if (old && next.name !== old.name) changes.push(`ステータス：${old.name} → ${next.name}`);
  }

  if ("priority" in raw && raw.priority !== undefined) {
    try {
      const priority = resolver.resolvePriority(raw.priority);
      if (priority !== row.priority) {
        patch.priority = priority;
        changes.push(`優先度：${priorityShort(row.priority)} → ${priorityShort(priority)}`);
      }
    } catch (e) {
      fail("優先度", e);
    }
  }

  if ("assignee" in raw && raw.assignee !== undefined) {
    try {
      const nextId = isCleared(raw.assignee) ? null : resolver.resolveUser(raw.assignee).id;
      if (nextId !== row.assignee_id) {
        patch.assigneeId = nextId;
        const oldName = row.assignee_id ? await resolver.userName(row.assignee_id) : "なし";
        const nextName = nextId ? resolver.snap.memberById.get(nextId)?.name ?? (await resolver.userName(nextId)) : "なし";
        changes.push(`担当者：${oldName} → ${nextName}`);
      }
    } catch (e) {
      fail("担当者", e);
    }
  }

  const hasLabels = "labels" in raw && raw.labels !== undefined;
  const hasAdd = "addLabels" in raw && raw.addLabels !== undefined;
  const hasRemove = "removeLabels" in raw && raw.removeLabels !== undefined;
  if (hasLabels && (hasAdd || hasRemove)) {
    fail("ラベル", new ToolError("labels と addLabels / removeLabels は同時に指定できません"));
  } else if (hasLabels || hasAdd || hasRemove) {
    try {
      const current = idsOf(row.label_ids);
      let next: string[];
      if (hasLabels) next = resolver.resolveLabels(raw.labels);
      else {
        const add = hasAdd ? resolver.resolveLabels(raw.addLabels) : [];
        const remove = hasRemove ? resolver.resolveLabels(raw.removeLabels) : [];
        next = [...current];
        for (const id of add) if (!next.includes(id)) next.push(id);
        next = next.filter((id) => !remove.includes(id));
      }
      if (!sameIds(current, next)) {
        patch.labelIds = next;
        const added = next.filter((id) => !current.includes(id));
        const removed = current.filter((id) => !next.includes(id));
        changes.push(labelChange(resolver, added, removed));
      }
    } catch (e) {
      fail("ラベル", e);
    }
  }

  if ("project" in raw && raw.project !== undefined) {
    try {
      const nextId = isCleared(raw.project) ? null : resolver.resolveProject(raw.project).id;
      if (nextId !== row.project_id) {
        patch.projectId = nextId;
        const oldName = row.project_id ? resolver.snap.projectById.get(row.project_id)?.name ?? "なし" : "なし";
        const nextName = nextId ? resolver.snap.projectById.get(nextId)?.name ?? "なし" : "なし";
        changes.push(`プロジェクト：${oldName} → ${nextName}`);
      }
    } catch (e) {
      fail("プロジェクト", e);
    }
  }

  if (team && !teamFailed && "cycle" in raw && raw.cycle !== undefined) {
    try {
      const nextId = isCleared(raw.cycle) ? null : resolver.resolveCycle(team, raw.cycle).id;
      if (nextId !== row.cycle_id) {
        patch.cycleId = nextId;
        const oldName = row.cycle_id ? cycleName(resolver, row.cycle_id) : "なし";
        const nextName = nextId ? cycleName(resolver, nextId) : "なし";
        changes.push(`サイクル：${oldName} → ${nextName}`);
      }
    } catch (e) {
      fail("サイクル", e);
    }
  } else if (moving && row.cycle_id) {
    changes.push(`サイクル：${cycleName(resolver, row.cycle_id)} → なし`);
  }

  if ("estimate" in raw && raw.estimate !== undefined) {
    try {
      const next = isCleared(raw.estimate) ? null : parseEstimate(raw.estimate);
      if (next !== row.estimate) {
        patch.estimate = next;
        changes.push(`見積もり：${row.estimate ?? "なし"} → ${next ?? "なし"}`);
      }
    } catch (e) {
      fail("見積もり", e);
    }
  }

  if ("dueDate" in raw && raw.dueDate !== undefined) {
    try {
      const next = isCleared(raw.dueDate) ? null : parseDueDate(raw.dueDate);
      if (next !== row.due_date) {
        patch.dueDate = next;
        changes.push(`期日：${row.due_date ?? "なし"} → ${next ?? "なし"}`);
      }
    } catch (e) {
      fail("期日", e);
    }
  }

  if ("parent" in raw && raw.parent !== undefined) {
    try {
      if (isCleared(raw.parent)) {
        if (row.parent_id) {
          patch.parentId = null;
          changes.push(`親課題：${(await resolver.parentIdent(row.parent_id)) ?? "なし"} → なし`);
        }
      } else {
        const parent = await resolver.resolveIssue(raw.parent);
        if (parent.archived_at != null) throw new ToolError(`${resolver.ident(parent)} は削除されています`);
        await resolver.assertCanParent(parent.id, row.id);
        if (parent.id !== row.parent_id) {
          patch.parentId = parent.id;
          const oldName = row.parent_id ? (await resolver.parentIdent(row.parent_id)) ?? "なし" : "なし";
          changes.push(`親課題：${oldName} → ${resolver.ident(parent)}`);
        }
      }
    } catch (e) {
      fail("親課題", e);
    }
  }

  if (failed) return null;
  if (!Object.keys(patch).length) return "unchanged";
  return { row, ident, patch, changes };
}

function cycleName(resolver: Resolver, id: string): string {
  const cycle = resolver.snap.cycleById.get(id);
  return cycle ? cycleLabel(cycle) : "なし";
}

async function updateIssues(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {});
  rejectUnknown(raw, ["updates"]);
  if (!Array.isArray(raw.updates)) throw new ToolError("updates は配列で指定してください");
  if (!raw.updates.length) throw new ToolError("更新する課題を 1 件以上指定してください");
  if (raw.updates.length > MAX_BATCH) throw new ToolError("一度に更新できる課題は 50 件までです");

  const errors: string[] = [];
  const seen = new Set<string>();
  const plans: UpdatePlan[] = [];
  const unchanged: string[] = [];
  for (let i = 0; i < raw.updates.length; i++) {
    const plan = await planUpdate(ctx.resolver, raw.updates[i], i, errors, seen);
    if (plan === "unchanged") {
      const item = raw.updates[i];
      if (isObject(item) && typeof item.issue === "string") {
        try {
          unchanged.push(ctx.resolver.ident(await ctx.resolver.resolveIssue(item.issue)));
        } catch {
          unchanged.push(item.issue.trim());
        }
      }
    } else if (plan) plans.push(plan);
  }
  if (errors.length) throw new ToolError(errors.join("\n"));

  const updated = [];
  for (const plan of plans) {
    await mutate(ctx, { type: "issue.update", args: { id: plan.row.id, patch: plan.patch } });
    const after = await ctx.resolver.issueById(plan.row.id);
    const ident = after ? ctx.resolver.ident(after) : plan.ident;
    const item: Record<string, unknown> = {
      id: ident,
      url: ctx.resolver.issueUrl(ident),
      changes: plan.changes,
    };
    if (ident !== plan.ident) item.previousId = plan.ident;
    updated.push(item);
  }
  const result: Record<string, unknown> = { summary: `${updated.length}件の課題を更新しました`, updated };
  if (unchanged.length) result.unchanged = unchanged;
  return result;
}

// ---- コメント・関係 ----

async function addComment(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {});
  rejectUnknown(raw, ["issue", "body"]);
  const resolver = ctx.resolver;
  const row = await resolver.resolveIssue(raw.issue);
  const ident = resolver.ident(row);
  if (row.archived_at != null) throw new ToolError(`${ident} は削除されています`);
  if (typeof raw.body !== "string" || !raw.body.trim()) throw new ToolError("コメントを入力してください");
  const html = markdownToHtml(raw.body);
  if (html.length > 100_000) throw new ToolError("本文が長すぎます");
  if (!htmlToText(html)) throw new ToolError("コメントを入力してください");
  await mutate(ctx, { type: "comment.create", args: { id: crypto.randomUUID(), issueId: row.id, body: html } });
  return { summary: `${ident} にコメントしました`, issue: ident, url: resolver.issueUrl(ident) };
}

const LINK_TYPES = ["blocks", "blocked_by", "related", "duplicate_of"] as const;
type LinkType = (typeof LINK_TYPES)[number];

async function linkIssues(ctx: ToolContext, args: unknown): Promise<unknown> {
  const raw = asObject(args ?? {});
  rejectUnknown(raw, ["issue", "type", "target", "remove"]);
  if (typeof raw.type !== "string" || !LINK_TYPES.includes(raw.type as LinkType)) {
    throw new ToolError("関係の種類は blocks、blocked_by、related、duplicate_of のいずれかで指定してください");
  }
  const type = raw.type as LinkType;
  const remove = raw.remove === undefined ? false : asBool(raw.remove, "remove");
  const resolver = ctx.resolver;
  const issue = await resolver.resolveIssue(raw.issue);
  const target = await resolver.resolveIssue(raw.target);
  const issueIdent = resolver.ident(issue);
  const targetIdent = resolver.ident(target);
  if (issue.archived_at != null) throw new ToolError(`${issueIdent} は削除されています`);
  if (target.archived_at != null) throw new ToolError(`${targetIdent} は削除されています`);
  if (issue.id === target.id) throw new ToolError("自分自身とは関係を設定できません");

  const stored = type === "duplicate_of" ? "duplicate" : type === "related" ? "related" : "blocks";
  const id = type === "blocked_by" ? target.id : issue.id;
  const targetId = type === "blocked_by" ? issue.id : target.id;
  await mutate(ctx, {
    type: remove ? "issue.unrelate" : "issue.relate",
    args: { id, type: stored, targetId },
  });

  let statusName: string | undefined;
  if (!remove && type === "duplicate_of") {
    const state = resolver.snap.stateById.get(issue.state_id);
    if (state && state.type !== "completed" && state.type !== "canceled") {
      const team = resolver.snap.teamById.get(issue.team_id);
      const dup = team ? resolver.duplicateState(team) : undefined;
      if (dup && dup.id !== issue.state_id) {
        await mutate(ctx, { type: "issue.update", args: { id: issue.id, patch: { stateId: dup.id } } });
        statusName = dup.name;
      }
    }
  }
  return { summary: linkSummary(type, remove, issueIdent, targetIdent, statusName), issue: issueIdent, target: targetIdent };
}

function linkSummary(type: LinkType, remove: boolean, issue: string, target: string, statusName?: string): string {
  if (remove) {
    if (type === "related") return `${issue} と ${target} の関連を外しました`;
    if (type === "duplicate_of") return `${issue} と ${target} の重複関係を外しました`;
    return `${issue} と ${target} のブロック関係を外しました`;
  }
  if (type === "blocks") return `${issue} が ${target} をブロックするようにしました`;
  if (type === "blocked_by") return `${issue} が ${target} にブロックされるようにしました`;
  if (type === "related") return `${issue} と ${target} を関連づけました`;
  return statusName ? `${issue} を ${target} の重複にしました（ステータス：${statusName}）` : `${issue} を ${target} の重複にしました`;
}

const searchSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: str("タイトル・説明・課題 ID（ENG-12）を空白区切りで検索します。すべての語を含む課題だけが残ります"),
    team: str("チームのキーまたは名前"),
    status: {
      type: "array",
      items: { type: "string" },
      description: "ステータスの名前か種類。いずれかに当てはまる課題を残します。指定すると includeClosed は無視されます",
    },
    assignee: str("担当者。「me」「自分」、名前、メールアドレス。「none」「なし」で担当者なし"),
    labels: { type: "array", items: { type: "string" }, description: "ラベル名。いずれかを付けている課題を残します" },
    project: str("プロジェクト名。「none」「なし」でプロジェクトなし"),
    cycle: {
      type: ["string", "integer"],
      description: "「current」「next」「none」、番号、または名前。team を一緒に指定するとそのチームのサイクルです",
    },
    priority: {
      type: "array",
      items: { type: ["integer", "string"] },
      description: "優先度。0〜4、または なし / 緊急 / 高 / 中 / 低。いずれかに当てはまる課題を残します",
    },
    parent: str("親課題の ID。そのサブ課題だけを返します"),
    includeClosed: { type: "boolean", description: "完了とキャンセルも含めるか。既定は false。status を指定したときは無視されます" },
    sort: {
      ...str("並び順。updated（既定・更新が新しい順）、created（作成が新しい順）、priority（緊急→低→なし、同じなら更新が新しい順）"),
      enum: ["updated", "created", "priority"],
    },
    limit: { type: "integer", description: "取得件数。1〜200、既定 50" },
  },
};

export const TOOLS: McpTool[] = [
  {
    name: "get_workspace",
    title: "ワークスペースの情報",
    description:
      "接続中のワークスペースのチーム、ステータス、メンバー、ラベル、プロジェクト、今日の日付を返します。課題を作る・探す前に、名前の表記を確かめるため最初に呼んでください。",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: READ_ONLY,
    handle: getWorkspace,
  },
  {
    name: "search_issues",
    title: "課題を検索",
    description:
      "条件に合う課題を検索します。チーム・ステータス・担当者・ラベル・プロジェクト・サイクルは名前で指定します。ステータスは、同じ名前のステータスがあればその名前だけ、無ければ種類（started や done など）として解釈します。既定では完了とキャンセルを除き、更新が新しい順に最大 50 件です。削除済みの課題は含まれません。",
    inputSchema: searchSchema,
    annotations: READ_ONLY,
    handle: searchIssues,
  },
  {
    name: "get_issue",
    title: "課題の詳細",
    description:
      "課題 1 件の説明（Markdown）、サブ課題、関係、最新 30 件のコメント、ブランチ名を返します。課題は「ENG-12」、課題の URL、UUID のどれでも指定できます。削除済みの課題は archived が true になります。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue"],
      properties: { issue: str("課題の ID（例: ENG-12）、課題の URL、または UUID") },
    },
    annotations: READ_ONLY,
    handle: getIssue,
  },
  {
    name: "create_issues",
    title: "課題を作成",
    description:
      "課題をまとめて作成します（サブ課題を含めて 1 回 50 件まで）。タイトルは必須です。チームも必須ですが、parent を指定したときは省略でき、親課題のチームになります。ステータスを省略すると未着手になります。サブ課題は team を省略すると親のチーム、project を省略すると親のプロジェクトを引き継ぎます。サブ課題の中にさらにサブ課題は作れません。全部の検証が通ってから作成するので、1 件でも名前が間違っていると何も作成されません。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issues"],
      properties: {
        issues: { type: "array", minItems: 1, maxItems: MAX_BATCH, items: createIssueSchema, description: "作成する課題。サブ課題を含めて 50 件まで" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handle: createIssues,
  },
  {
    name: "update_issues",
    title: "課題を更新",
    description:
      "課題をまとめて更新します（1 回 50 件まで）。指定した項目だけを変えます。同じ値の項目は変更しません。labels はラベルの置き換え、addLabels と removeLabels は追加と削除です。両方は同時に使えません。team を指定するとそのチームへ移動し、課題の ID（番号）が変わります。ステータスとサイクルは移動先のチームで解決します。削除済みの課題は更新できません。全部の検証が通ってから更新します。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["updates"],
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          maxItems: MAX_BATCH,
          description: "更新する課題。1〜50 件",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["issue"],
            properties: {
              issue: str("課題の ID（例: ENG-12）、課題の URL、または UUID"),
              team: str("移動先のチームのキーまたは名前。指定すると課題の ID が変わります"),
              title: str("新しいタイトル（1〜500文字）"),
              ...fieldProps,
              addLabels: { type: "array", items: { type: "string" }, description: "追加するラベル名。labels とは同時に指定できません" },
              removeLabels: { type: "array", items: { type: "string" }, description: "外すラベル名。labels とは同時に指定できません" },
            },
          },
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handle: updateIssues,
  },
  {
    name: "add_comment",
    title: "コメントを追加",
    description: "課題にコメントを Markdown で追加します。本文に「@名前」と書くと、そのメンバーへ通知します。空のコメントは追加できません。削除済みの課題にはコメントできません。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "body"],
      properties: {
        issue: str("課題の ID（例: ENG-12）、課題の URL、または UUID"),
        body: str("コメント本文（Markdown）。空にはできません"),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handle: addComment,
  },
  {
    name: "link_issues",
    title: "課題を関係づける",
    description:
      "2 つの課題の関係を追加または解除します。type は blocks（この課題が対象をブロックする）、blocked_by（この課題が対象にブロックされている）、related（関連）、duplicate_of（この課題が対象の重複）です。remove を true にすると、その関係を外します。duplicate_of を設定したとき、課題が完了でもキャンセルでもなければ、ステータスを「重複」（無ければキャンセルの先頭）に移します。自分自身とは関係づけられません。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "type", "target"],
      properties: {
        issue: str("関係の起点になる課題の ID（例: ENG-12）、URL、または UUID"),
        type: {
          ...str("blocks、blocked_by、related、duplicate_of のいずれか"),
          enum: ["blocks", "blocked_by", "related", "duplicate_of"],
        },
        target: str("相手の課題の ID、URL、または UUID"),
        remove: { type: "boolean", description: "true のとき、指定した関係を外します。既定は false" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handle: linkIssues,
  },
];

export function toolDefinitions(scope: ApiTokenScope) {
  return TOOLS.filter((tool) => scope === "write" || tool.annotations.readOnlyHint).map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations,
  }));
}

export function findTool(name: string): McpTool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}
