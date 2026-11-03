// MCP ツールが使うワークスペースの読み込みと、名前 → ID の解決。
// 比較は normalizeSearch（ひらがな/カタカナ・全角/半角・大文字小文字）と前後の空白除去。

import { PRIORITIES, projectStatusLabel } from "../../shared/constants";
import { isValidYmd, todayYmd } from "../../shared/dates";
import { normalizeSearch } from "../../shared/text";
import type { IssueRelation, Me, ProjectStatus, RelationType, StateType } from "../../shared/types";
import { all, first } from "../db";
import type { WorkspaceRow } from "../env";
import { htmlToMarkdown } from "../markdown";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface StateSnap {
  id: string;
  teamId: string;
  name: string;
  type: StateType;
  position: number;
}

export interface CycleSnap {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

export interface TeamSnap {
  id: string;
  key: string;
  name: string;
  cyclesEnabled: boolean;
  states: StateSnap[];
  cycles: CycleSnap[];
}

export interface MemberSnap {
  id: string;
  name: string;
  email: string;
}

export interface LabelSnap {
  id: string;
  name: string;
}

export interface ProjectSnap {
  id: string;
  name: string;
  status: ProjectStatus;
  teamIds: string[];
}

export interface WorkspaceSnapshot {
  teams: TeamSnap[];
  teamById: Map<string, TeamSnap>;
  stateById: Map<string, StateSnap>;
  members: MemberSnap[];
  memberById: Map<string, MemberSnap>;
  labels: LabelSnap[];
  labelById: Map<string, LabelSnap>;
  projects: ProjectSnap[];
  projectById: Map<string, ProjectSnap>;
  cycleById: Map<string, CycleSnap>;
}

export interface IssueRow {
  id: string;
  team_id: string;
  number: number;
  title: string;
  description: string;
  state_id: string;
  priority: number;
  assignee_id: string | null;
  creator_id: string;
  project_id: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  label_ids: string;
  relations: string | null;
  estimate: number | null;
  due_date: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface CommentRow {
  body: string;
  created_at: number;
  via: string | null;
  author: string | null;
}

export type StatusMatch = { ids: Set<string> } | { type: StateType };

const CANDIDATES = 30;

const STATE_TYPE_ALIASES: [string, StateType][] = (
  [
    ["backlog", "backlog"],
    ["バックログ", "backlog"],
    ["unstarted", "unstarted"],
    ["todo", "unstarted"],
    ["未着手", "unstarted"],
    ["started", "started"],
    ["in progress", "started"],
    ["doing", "started"],
    ["進行中", "started"],
    ["completed", "completed"],
    ["done", "completed"],
    ["完了", "completed"],
    ["canceled", "canceled"],
    ["cancelled", "canceled"],
    ["キャンセル", "canceled"],
  ] as [string, StateType][]
).map(([alias, type]) => [normalizeSearch(alias), type]);

const PRIORITY_ALIASES: [string, number][] = (
  [
    ["none", 0],
    ["なし", 0],
    ["優先度なし", 0],
    ["urgent", 1],
    ["緊急", 1],
    ["high", 2],
    ["高", 2],
    ["medium", 3],
    ["中", 3],
    ["low", 4],
    ["低", 4],
  ] as [string, number][]
).map(([alias, value]) => [normalizeSearch(alias), value]);

function norm(s: string): string {
  return normalizeSearch(s.trim());
}

function squash(s: string): string {
  return norm(s).replace(/[\s\u3000]+/g, "");
}

function clip(s: string, max = 200): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function avail(prefix: string, items: string[]): string {
  if (!items.length) return `${prefix}はありません`;
  return `${prefix}：${items.slice(0, CANDIDATES).join("、")}`;
}

function jsonIds(v: string | null | undefined): string[] {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const RELATION_TYPES: RelationType[] = ["blocks", "related", "duplicate"];

function jsonRelations(v: string | null | undefined): IssueRelation[] {
  try {
    const a = JSON.parse(v || "[]");
    if (!Array.isArray(a)) return [];
    return a.filter(
      (r): r is IssueRelation => !!r && typeof r.issueId === "string" && RELATION_TYPES.includes(r.type as RelationType),
    );
  } catch {
    return [];
  }
}

function stateTypeOf(input: string): StateType | undefined {
  return STATE_TYPE_ALIASES.find(([alias]) => alias === norm(input))?.[1];
}

export function priorityShort(p: number): string {
  return PRIORITIES.find((x) => x.value === p)?.short ?? "なし";
}

export function cycleLabel(c: { number: number; name: string | null }): string {
  const name = c.name?.trim();
  return name ? name : `サイクル ${c.number}`;
}

/** null・"none"・「なし」は「外す」指定 */
export function isCleared(input: unknown): boolean {
  if (input === null) return true;
  if (typeof input !== "string") return false;
  const n = norm(input);
  return n === "none" || n === "なし";
}

export function parseDueDate(input: unknown): string {
  if (!isValidYmd(input)) throw new ToolError("期日は YYYY-MM-DD の形式で指定してください（例: 2026-11-30）");
  return input;
}

export function parseEstimate(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0 || input > 64) {
    throw new ToolError("見積もりは 0〜64 の整数で指定してください");
  }
  return input;
}

function cyclePeriod(c: CycleSnap): string {
  const head = c.name?.trim() ? `${c.number} ${c.name.trim()}` : String(c.number);
  return `${head}（${c.startsAt}〜${c.endsAt}）`;
}

function pickCurrent(cycles: CycleSnap[], today: string): CycleSnap | undefined {
  const hits = cycles.filter((c) => c.startsAt <= today && today <= c.endsAt);
  hits.sort((a, b) => (a.startsAt < b.startsAt ? 1 : a.startsAt > b.startsAt ? -1 : b.number - a.number));
  return hits[0];
}

function pickNext(cycles: CycleSnap[], today: string): CycleSnap | undefined {
  const hits = cycles.filter((c) => c.startsAt > today);
  hits.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.number - b.number));
  return hits[0];
}

interface TeamRow {
  id: string;
  name: string;
  key: string;
  cycles_enabled: number;
}
interface StateRow {
  id: string;
  team_id: string;
  name: string;
  type: StateType;
  position: number;
}
interface MemberRow {
  id: string;
  name: string;
  email: string;
}
interface LabelRow {
  id: string;
  name: string;
}
interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  team_ids: string;
}
interface CycleRow {
  id: string;
  team_id: string;
  number: number;
  name: string | null;
  starts_at: string;
  ends_at: string;
}

export async function loadWorkspace(db: D1Database, workspaceId: string): Promise<WorkspaceSnapshot> {
  const [teams, states, members, labels, projects, cycles] = await Promise.all([
    all<TeamRow>(db, "SELECT id, name, key, cycles_enabled FROM teams WHERE workspace_id = ? ORDER BY created_at", workspaceId),
    all<StateRow>(
      db,
      "SELECT id, team_id, name, type, position FROM workflow_states WHERE workspace_id = ? ORDER BY position",
      workspaceId,
    ),
    all<MemberRow>(
      db,
      `SELECT u.id, u.name, u.email FROM users u
       JOIN members m ON m.user_id = u.id
       WHERE m.workspace_id = ? ORDER BY m.created_at`,
      workspaceId,
    ),
    all<LabelRow>(db, "SELECT id, name FROM labels WHERE workspace_id = ? ORDER BY name", workspaceId),
    all<ProjectRow>(
      db,
      "SELECT id, name, status, team_ids FROM projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY sort_order, name",
      workspaceId,
    ),
    all<CycleRow>(
      db,
      "SELECT id, team_id, number, name, starts_at, ends_at FROM cycles WHERE workspace_id = ? ORDER BY number",
      workspaceId,
    ),
  ]);

  const teamById = new Map<string, TeamSnap>();
  const teamSnaps: TeamSnap[] = teams.map((t) => {
    const snap: TeamSnap = { id: t.id, key: t.key, name: t.name, cyclesEnabled: !!t.cycles_enabled, states: [], cycles: [] };
    teamById.set(t.id, snap);
    return snap;
  });
  const stateById = new Map<string, StateSnap>();
  for (const s of states) {
    const snap: StateSnap = { id: s.id, teamId: s.team_id, name: s.name, type: s.type, position: s.position };
    stateById.set(s.id, snap);
    teamById.get(s.team_id)?.states.push(snap);
  }
  const cycleById = new Map<string, CycleSnap>();
  for (const c of cycles) {
    const snap: CycleSnap = {
      id: c.id,
      teamId: c.team_id,
      number: c.number,
      name: c.name,
      startsAt: c.starts_at,
      endsAt: c.ends_at,
    };
    cycleById.set(c.id, snap);
    teamById.get(c.team_id)?.cycles.push(snap);
  }
  const memberSnaps = members.map((m) => ({ id: m.id, name: m.name, email: m.email }));
  const labelSnaps = labels.map((l) => ({ id: l.id, name: l.name }));
  const projectSnaps: ProjectSnap[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    teamIds: jsonIds(p.team_ids),
  }));
  return {
    teams: teamSnaps,
    teamById,
    stateById,
    members: memberSnaps,
    memberById: new Map(memberSnaps.map((m) => [m.id, m])),
    labels: labelSnaps,
    labelById: new Map(labelSnaps.map((l) => [l.id, l])),
    projects: projectSnaps,
    projectById: new Map(projectSnaps.map((p) => [p.id, p])),
    cycleById,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Resolver {
  constructor(
    private db: D1Database,
    private workspaceId: string,
    readonly me: Pick<Me, "id" | "name" | "email">,
    readonly snap: WorkspaceSnapshot,
    readonly origin: string,
    readonly urlKey: string,
    private wsName: string,
    readonly today: string,
  ) {}

  ident(row: Pick<IssueRow, "team_id" | "number">): string {
    const key = this.snap.teamById.get(row.team_id)?.key ?? "?";
    return `${key}-${row.number}`;
  }

  issueUrl(ident: string): string {
    return `${this.origin}/${this.urlKey}/issue/${ident}`;
  }

  stateName(stateId: string): string {
    return this.snap.stateById.get(stateId)?.name ?? "不明";
  }

  isClosed(stateId: string): boolean {
    const type = this.snap.stateById.get(stateId)?.type;
    return type === "completed" || type === "canceled";
  }

  /** 作成時の既定（未着手）。アプリの defaultStateId と同じ */
  defaultState(team: TeamSnap): StateSnap | undefined {
    return team.states.find((s) => s.type === "unstarted") ?? team.states[0];
  }

  /** チーム移動で種類を保つときの先。defaultStateId(type) と同じ */
  stateForType(team: TeamSnap, type: StateType): StateSnap | undefined {
    return team.states.find((s) => s.type === type) ?? this.defaultState(team);
  }

  /** 重複にしたときに移すキャンセルのステータス（画面の relateIssues と同じ） */
  duplicateState(team: TeamSnap): StateSnap | undefined {
    const canceled = team.states.filter((s) => s.type === "canceled");
    return canceled.find((s) => s.name === "重複") ?? canceled.find((s) => norm(s.name) === norm("重複")) ?? canceled[0];
  }

  currentCycle(team: TeamSnap): CycleSnap | undefined {
    return pickCurrent(team.cycles, this.today);
  }

  nextCycle(team: TeamSnap): CycleSnap | undefined {
    return pickNext(team.cycles, this.today);
  }

  labelNames(ids: string[]): string[] {
    const names: string[] = [];
    for (const id of ids) {
      const name = this.snap.labelById.get(id)?.name;
      if (name) names.push(name);
    }
    return names;
  }

  resolveTeam(input: unknown): TeamSnap {
    if (typeof input !== "string" || !input.trim()) throw new ToolError("チームはキーまたは名前で指定してください");
    const n = norm(input);
    const matches = this.snap.teams.filter((t) => norm(t.key) === n || norm(t.name) === n);
    if (matches.length === 1) return matches[0];
    const list = avail(
      "使えるチーム",
      this.snap.teams.map((t) => `${t.key}（${t.name}）`),
    );
    if (matches.length > 1) {
      throw new ToolError(`チーム「${clip(input)}」が複数に当てはまります。${list}`);
    }
    throw new ToolError(`チーム「${clip(input)}」が見つかりません。${list}`);
  }

  resolveState(team: TeamSnap, input: unknown): StateSnap {
    if (typeof input !== "string" || !input.trim()) throw new ToolError("ステータスは名前で指定してください");
    const n = norm(input);
    const named = team.states.find((s) => norm(s.name) === n);
    if (named) return named;
    const type = stateTypeOf(input);
    if (type) {
      const st = team.states.find((s) => s.type === type);
      if (st) return st;
    }
    throw new ToolError(`ステータス「${clip(input)}」が見つかりません。${avail("使えるステータス", team.states.map((s) => s.name))}`);
  }

  /**
   * 検索用。名前がどこかのステータスと完全一致すればその名前だけ。
   * 一致が無ければ種類（done、進行中 など）として解釈する。
   */
  resolveStatusFilter(input: unknown, team?: TeamSnap): StatusMatch {
    if (typeof input !== "string" || !input.trim()) throw new ToolError("ステータスは名前で指定してください");
    const pool = team ? team.states : this.snap.teams.flatMap((t) => t.states);
    const n = norm(input);
    const named = pool.filter((s) => norm(s.name) === n);
    if (named.length) return { ids: new Set(named.map((s) => s.id)) };
    const type = stateTypeOf(input);
    if (type) return { type };
    const names = [...new Set(pool.map((s) => s.name))];
    throw new ToolError(`ステータス「${clip(input)}」が見つかりません。${avail("使えるステータス", names)}`);
  }

  matchesStatus(stateId: string, filters: StatusMatch[]): boolean {
    const state = this.snap.stateById.get(stateId);
    if (!state) return false;
    return filters.some((f) => ("ids" in f ? f.ids.has(state.id) : state.type === f.type));
  }

  resolveUser(input: unknown): MemberSnap {
    if (typeof input !== "string" || !input.trim()) throw new ToolError("担当者は名前、メールアドレス、「me」のいずれかで指定してください");
    const n = norm(input);
    if (n === "me" || n === "自分" || n === "私") {
      return this.snap.memberById.get(this.me.id) ?? { id: this.me.id, name: this.me.name, email: this.me.email };
    }
    const members = this.snap.members;
    const byEmail = members.filter((m) => norm(m.email) === n);
    if (byEmail.length === 1) return byEmail[0];
    const byName = members.filter((m) => norm(m.name) === n);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw this.multipleMembers(input, byName);
    const qSquash = squash(input);
    const bySquash = qSquash ? members.filter((m) => squash(m.name) === qSquash) : [];
    if (bySquash.length === 1) return bySquash[0];
    if (bySquash.length > 1) throw this.multipleMembers(input, bySquash);
    const partial = members.filter((m) => norm(m.name).includes(n) || (qSquash.length > 0 && squash(m.name).includes(qSquash)));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw this.multipleMembers(input, partial);
    throw new ToolError(`メンバー「${clip(input)}」が見つかりません。${avail("使えるメンバー", members.map((m) => m.name))}`);
  }

  private multipleMembers(input: unknown, members: MemberSnap[]): ToolError {
    const names = members.slice(0, CANDIDATES).map((m) => m.name).join("、");
    return new ToolError(`「${clip(String(input))}」に当てはまるメンバーが複数います：${names}。名前かメールアドレスで指定してください`);
  }

  resolvePriority(input: unknown): number {
    if (typeof input === "number" && Number.isInteger(input) && input >= 0 && input <= 4) return input;
    if (typeof input === "string" && input.trim()) {
      const n = norm(input);
      if (/^[0-4]$/.test(n)) return Number(n);
      const found = PRIORITY_ALIASES.find(([alias]) => alias === n);
      if (found) return found[1];
    }
    const shown = typeof input === "string" || typeof input === "number" ? clip(String(input)) : "";
    throw new ToolError(`優先度「${shown}」は使えません。使える優先度：緊急、高、中、低、なし`);
  }

  resolveLabels(input: unknown): string[] {
    if (!Array.isArray(input) || input.some((x) => typeof x !== "string")) {
      throw new ToolError("ラベルは名前の配列で指定してください");
    }
    const missing: string[] = [];
    const ids: string[] = [];
    for (const name of input) {
      const hit = this.snap.labels.find((l) => norm(l.name) === norm(name));
      if (!hit) missing.push(name);
      else if (!ids.includes(hit.id)) ids.push(hit.id);
    }
    if (missing.length) {
      const quoted = missing.slice(0, CANDIDATES).map((n) => `「${clip(n, 80)}」`).join("");
      throw new ToolError(`ラベル${quoted}が見つかりません。${avail("使えるラベル", this.snap.labels.map((l) => l.name))}`);
    }
    return ids;
  }

  resolveProject(input: unknown): ProjectSnap {
    if (typeof input !== "string" || !input.trim()) throw new ToolError("プロジェクトは名前で指定してください");
    const n = norm(input);
    const projects = this.snap.projects;
    const exact = projects.filter((p) => norm(p.name) === n);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw this.multipleProjects(input, exact);
    const partial = projects.filter((p) => norm(p.name).includes(n));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw this.multipleProjects(input, partial);
    throw new ToolError(`プロジェクト「${clip(input)}」が見つかりません。${avail("使えるプロジェクト", projects.map((p) => p.name))}`);
  }

  private multipleProjects(input: unknown, projects: ProjectSnap[]): ToolError {
    const names = projects.slice(0, CANDIDATES).map((p) => p.name).join("、");
    return new ToolError(`「${clip(String(input))}」に当てはまるプロジェクトが複数あります：${names}。名前を詳しく指定してください`);
  }

  resolveCycle(team: TeamSnap, input: unknown): CycleSnap {
    if (!team.cyclesEnabled) throw new ToolError(`${team.key} チームはサイクルを使っていません`);
    const list = () => avail("使えるサイクル", [...team.cycles].sort((a, b) => a.number - b.number).map(cyclePeriod));
    if (typeof input === "number") {
      if (!Number.isInteger(input) || input < 0) throw new ToolError(`サイクル「${input}」が見つかりません。${list()}`);
      const found = team.cycles.find((c) => c.number === input);
      if (!found) throw new ToolError(`サイクル「${input}」が見つかりません。${list()}`);
      return found;
    }
    if (typeof input !== "string" || !input.trim()) {
      throw new ToolError("サイクルは名前、番号、「current」、「next」のいずれかで指定してください");
    }
    const n = norm(input);
    if (n === "none" || n === "なし") throw new ToolError("サイクルを外すときは null を指定してください");
    if (n === "current" || n === "今" || n === "現在") {
      const found = this.currentCycle(team);
      if (!found) throw new ToolError(`現在のサイクルが見つかりません。${list()}`);
      return found;
    }
    if (n === "next" || n === "次") {
      const found = this.nextCycle(team);
      if (!found) throw new ToolError(`次のサイクルが見つかりません。${list()}`);
      return found;
    }
    if (/^\d+$/.test(n)) {
      const num = Number(n);
      const found = Number.isSafeInteger(num) ? team.cycles.find((c) => c.number === num) : undefined;
      if (!found) throw new ToolError(`サイクル「${clip(input)}」が見つかりません。${list()}`);
      return found;
    }
    const named = team.cycles.filter((c) => c.name && norm(c.name) === n);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      throw new ToolError(`「${clip(input)}」に当てはまるサイクルが複数あります：${named.map(cyclePeriod).join("、")}。番号で指定してください`);
    }
    throw new ToolError(`サイクル「${clip(input)}」が見つかりません。${list()}`);
  }

  /** 検索用。チームが無いときはワークスペース全体で解釈する */
  resolveCycleFilter(input: unknown, team?: TeamSnap): "none" | Set<string> {
    if (typeof input === "string" && (norm(input) === "none" || norm(input) === "なし")) return "none";
    if (team) return new Set([this.resolveCycle(team, input).id]);
    const n = typeof input === "string" ? norm(input) : "";
    const teams = this.snap.teams.filter((t) => t.cyclesEnabled);
    const ids = new Set<string>();
    if (n === "current" || n === "今" || n === "現在") {
      for (const t of teams) {
        const c = pickCurrent(t.cycles, this.today);
        if (c) ids.add(c.id);
      }
      if (!ids.size) throw new ToolError(`現在のサイクルが見つかりません。${this.workspaceCycles()}`);
      return ids;
    }
    if (n === "next" || n === "次") {
      for (const t of teams) {
        const c = pickNext(t.cycles, this.today);
        if (c) ids.add(c.id);
      }
      if (!ids.size) throw new ToolError(`次のサイクルが見つかりません。${this.workspaceCycles()}`);
      return ids;
    }
    const num = typeof input === "number" && Number.isInteger(input) ? input : n && /^\d+$/.test(n) ? Number(n) : null;
    if (num != null) {
      for (const t of teams) for (const c of t.cycles) if (c.number === num) ids.add(c.id);
      if (!ids.size) throw new ToolError(`サイクル「${num}」が見つかりません。${this.workspaceCycles()}`);
      return ids;
    }
    if (typeof input !== "string" || !input.trim()) {
      throw new ToolError("サイクルは「current」「next」「none」または番号で指定してください");
    }
    for (const t of teams) for (const c of t.cycles) if (c.name && norm(c.name) === n) ids.add(c.id);
    if (!ids.size) throw new ToolError(`サイクル「${clip(input)}」が見つかりません。${this.workspaceCycles()}`);
    return ids;
  }

  private workspaceCycles(): string {
    const items: string[] = [];
    for (const t of this.snap.teams) {
      for (const c of [...t.cycles].sort((a, b) => a.number - b.number)) items.push(`${t.key} ${cyclePeriod(c)}`);
    }
    return avail("使えるサイクル", items);
  }

  async resolveIssue(input: unknown): Promise<IssueRow> {
    if (typeof input !== "string" || !input.trim()) throw new ToolError("課題は「ENG-12」の形式で指定してください");
    const text = input.trim().normalize("NFKC");
    if (UUID.test(text)) {
      const row = await this.issueById(text.toLowerCase());
      if (!row) throw new ToolError(`課題「${clip(text)}」が見つかりません`);
      return row;
    }
    const url = /\/issue\/([A-Za-z][A-Za-z0-9]*)-(\d+)/i.exec(text);
    const whole = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(text.trim());
    const parsed = url ? { key: url[1], number: Number(url[2]) } : whole ? { key: whole[1], number: Number(whole[2]) } : null;
    if (!parsed) throw new ToolError(`課題「${clip(input)}」が見つかりません`);
    const team = this.snap.teams.find((t) => norm(t.key) === norm(parsed.key));
    if (!team) throw new ToolError(`課題「${clip(input)}」が見つかりません`);
    const row = await first<IssueRow>(
      this.db,
      "SELECT * FROM issues WHERE workspace_id = ? AND team_id = ? AND number = ?",
      this.workspaceId,
      team.id,
      parsed.number,
    );
    if (!row) throw new ToolError(`課題「${team.key}-${parsed.number}」が見つかりません`);
    return row;
  }

  async assertCanParent(parentId: string, selfId: string): Promise<void> {
    if (parentId === selfId) throw new ToolError("自分自身を親課題にはできません");
    let cur: string | null = parentId;
    for (let i = 0; cur && i < 50; i++) {
      const r: { id: string; parent_id: string | null } | null = await first(
        this.db,
        "SELECT id, parent_id FROM issues WHERE id = ? AND workspace_id = ?",
        cur,
        this.workspaceId,
      );
      if (!r) throw new ToolError("親課題が見つかりません");
      if (r.parent_id === selfId) throw new ToolError("循環する親子関係は設定できません");
      cur = r.parent_id;
    }
  }

  summarize(row: IssueRow, parents?: Map<string, IssueRow>): Record<string, unknown> {
    const ident = this.ident(row);
    const state = this.snap.stateById.get(row.state_id);
    const out: Record<string, unknown> = {
      id: ident,
      title: row.title,
      status: state?.name ?? "不明",
      statusType: state?.type,
      priority: priorityShort(row.priority),
      url: this.issueUrl(ident),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
    if (row.assignee_id) {
      const name = this.snap.memberById.get(row.assignee_id)?.name;
      if (name) out.assignee = name;
    }
    const labels = this.labelNames(jsonIds(row.label_ids));
    if (labels.length) out.labels = labels;
    if (row.project_id) {
      const project = this.snap.projectById.get(row.project_id)?.name;
      if (project) out.project = project;
    }
    if (row.cycle_id) {
      const cycle = this.snap.cycleById.get(row.cycle_id);
      if (cycle) out.cycle = cycleLabel(cycle);
    }
    if (row.estimate != null) out.estimate = row.estimate;
    if (row.due_date) out.dueDate = row.due_date;
    if (row.parent_id) {
      const parent = parents?.get(row.parent_id);
      if (parent) out.parent = this.ident(parent);
    }
    return out;
  }

  async parentIdent(parentId: string | null): Promise<string | undefined> {
    if (!parentId) return undefined;
    const row = await this.issueById(parentId);
    return row ? this.ident(row) : undefined;
  }

  branchName(row: IssueRow): string {
    const key = this.snap.teamById.get(row.team_id)?.key ?? "x";
    const user = (this.me.email ?? "me").split("@")[0].toLowerCase().replace(/[^a-z0-9-]/g, "");
    return `${user}/${key.toLowerCase()}-${row.number}`;
  }

  ref(row: IssueRow): { id: string; title: string; status: string } {
    return { id: this.ident(row), title: row.title, status: this.stateName(row.state_id) };
  }

  async issueById(id: string): Promise<IssueRow | null> {
    return first<IssueRow>(this.db, "SELECT * FROM issues WHERE id = ? AND workspace_id = ?", id, this.workspaceId);
  }

  async loadIssues(): Promise<IssueRow[]> {
    return all<IssueRow>(this.db, "SELECT * FROM issues WHERE workspace_id = ?", this.workspaceId);
  }

  async issueNumbers(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await all<{ id: string; number: number }>(
      this.db,
      `SELECT id, number FROM issues WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      this.workspaceId,
      ...ids,
    );
    return new Map(rows.map((r) => [r.id, r.number]));
  }

  async minSort(teamId: string, stateId: string): Promise<number | null> {
    const r = await first<{ m: number | null }>(
      this.db,
      "SELECT MIN(sort_order) AS m FROM issues WHERE team_id = ? AND state_id = ?",
      teamId,
      stateId,
    );
    return r?.m ?? null;
  }

  async childrenOf(parentId: string): Promise<IssueRow[]> {
    return all<IssueRow>(
      this.db,
      `SELECT * FROM issues WHERE workspace_id = ? AND parent_id = ? AND archived_at IS NULL
       ORDER BY sort_order ASC, number ASC`,
      this.workspaceId,
      parentId,
    );
  }

  async relationsOf(row: IssueRow): Promise<Record<string, unknown> | undefined> {
    const own = jsonRelations(row.relations);
    const targetRows = await this.issuesByIds(own.map((r) => r.issueId));
    const byId = new Map(targetRows.map((t) => [t.id, t]));
    const blocks: { id: string; title: string; status: string }[] = [];
    const related: { id: string; title: string; status: string }[] = [];
    let duplicateOf: { id: string; title: string; status: string } | undefined;
    const seenRelated = new Set<string>();
    for (const rel of own) {
      const target = byId.get(rel.issueId);
      if (!target || target.archived_at != null) continue;
      const ref = this.ref(target);
      if (rel.type === "blocks") blocks.push(ref);
      else if (rel.type === "related" && !seenRelated.has(ref.id)) {
        related.push(ref);
        seenRelated.add(ref.id);
      } else if (rel.type === "duplicate" && !duplicateOf) duplicateOf = ref;
    }
    const reverse = await all<IssueRow>(
      this.db,
      "SELECT * FROM issues WHERE workspace_id = ? AND id != ? AND instr(relations, ?) > 0",
      this.workspaceId,
      row.id,
      row.id,
    );
    const blockedBy: { id: string; title: string; status: string }[] = [];
    const duplicates: { id: string; title: string; status: string }[] = [];
    const seenBlock = new Set<string>();
    const seenDup = new Set<string>();
    for (const other of reverse) {
      if (other.archived_at != null) continue;
      const ref = this.ref(other);
      for (const rel of jsonRelations(other.relations)) {
        if (rel.issueId !== row.id) continue;
        if (rel.type === "blocks" && !seenBlock.has(ref.id)) {
          blockedBy.push(ref);
          seenBlock.add(ref.id);
        } else if (rel.type === "duplicate" && !seenDup.has(ref.id)) {
          duplicates.push(ref);
          seenDup.add(ref.id);
        } else if (rel.type === "related" && !seenRelated.has(ref.id)) {
          related.push(ref);
          seenRelated.add(ref.id);
        }
      }
    }
    const out: Record<string, unknown> = {};
    if (blocks.length) out.blocks = blocks;
    if (blockedBy.length) out.blockedBy = blockedBy;
    if (related.length) out.related = related;
    if (duplicateOf) out.duplicateOf = duplicateOf;
    if (duplicates.length) out.duplicates = duplicates;
    return Object.keys(out).length ? out : undefined;
  }

  private async issuesByIds(ids: string[]): Promise<IssueRow[]> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return [];
    return all<IssueRow>(
      this.db,
      `SELECT * FROM issues WHERE workspace_id = ? AND id IN (${uniq.map(() => "?").join(",")})`,
      this.workspaceId,
      ...uniq,
    );
  }

  async commentsOf(issueId: string): Promise<{ comments: Record<string, unknown>[]; note?: string }> {
    const totalRow = await first<{ c: number }>(
      this.db,
      "SELECT COUNT(*) AS c FROM comments WHERE workspace_id = ? AND issue_id = ?",
      this.workspaceId,
      issueId,
    );
    const total = totalRow?.c ?? 0;
    if (!total) return { comments: [] };
    const rows = await all<CommentRow>(
      this.db,
      `SELECT c.body, c.created_at, c.via, u.name AS author
       FROM comments c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.workspace_id = ? AND c.issue_id = ?
       ORDER BY c.created_at DESC LIMIT 30`,
      this.workspaceId,
      issueId,
    );
    const comments = rows.reverse().map((r) => {
      const item: Record<string, unknown> = {
        author: r.author || "不明",
        createdAt: new Date(r.created_at).toISOString(),
        body: htmlToMarkdown(r.body ?? ""),
      };
      if (r.via) item.via = r.via;
      return item;
    });
    const note = total > 30 ? `古いコメント ${total - 30} 件は省略しました` : undefined;
    return { comments, note };
  }

  async userName(id: string): Promise<string> {
    const member = this.snap.memberById.get(id);
    if (member) return member.name;
    const row = await first<{ name: string }>(this.db, "SELECT name FROM users WHERE id = ?", id);
    return row?.name ?? "不明";
  }

  workspaceView(permission: "read" | "write"): Record<string, unknown> {
    return {
      workspace: { name: this.wsName, url: `${this.origin}/${this.urlKey}` },
      you: { name: this.me.name, email: this.me.email },
      permission,
      today: this.today,
      teams: this.snap.teams.map((t) => {
        const team: Record<string, unknown> = {
          key: t.key,
          name: t.name,
          statuses: t.states.map((s) => ({ name: s.name, type: s.type })),
        };
        if (t.cyclesEnabled) {
          const cycles: Record<string, unknown> = {};
          const current = this.currentCycle(t);
          const next = this.nextCycle(t);
          if (current) cycles.current = cycleBrief(current);
          if (next) cycles.next = cycleBrief(next);
          if (current || next) team.cycles = cycles;
        }
        return team;
      }),
      members: this.snap.members.map((m) => ({ name: m.name, email: m.email })),
      labels: this.snap.labels.map((l) => l.name),
      projects: this.snap.projects.map((p) => ({
        name: p.name,
        status: projectStatusLabel(p.status),
        teams: p.teamIds.map((id) => this.snap.teamById.get(id)?.key).filter((k): k is string => !!k),
      })),
      priorities: ["緊急", "高", "中", "低", "なし"],
    };
  }
}

function cycleBrief(c: CycleSnap): Record<string, unknown> {
  const out: Record<string, unknown> = { number: c.number, startsAt: c.startsAt, endsAt: c.endsAt };
  const name = c.name?.trim();
  if (name) out.name = name;
  return out;
}

export async function openResolver(db: D1Database, ws: WorkspaceRow, user: Me, origin: string): Promise<Resolver> {
  const snap = await loadWorkspace(db, ws.id);
  return new Resolver(db, ws.id, user, snap, origin, ws.url_key, ws.name, todayYmd());
}
