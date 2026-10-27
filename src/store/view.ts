import { useCallback, useState } from "react";
import type { Issue, StateType } from "../../shared/types";
import { PRIORITY_ORDER, priorityLabel } from "../../shared/constants";
import { readLocal, writeLocal } from "../lib/utils";
import type { DataState } from "./data";
import { cycleName, sortStates } from "./selectors";
import type { CreateIssueDefaults } from "./ui";

// ---------------------------------------------------------------------------
// 一覧の表示設定（フィルター・グループ・並び順）と、その計算
// ---------------------------------------------------------------------------

export type Grouping = "status" | "assignee" | "priority" | "project" | "cycle" | "label" | "none";
export type Ordering = "manual" | "priority" | "updated" | "created" | "dueDate";
export type CompletedMode = "all" | "week" | "month" | "none";
export type PropKey = "id" | "status" | "priority" | "labels" | "project" | "cycle" | "dueDate" | "estimate" | "assignee" | "created";

export interface ViewOptions {
  layout: "list" | "board";
  grouping: Grouping;
  ordering: Ordering;
  completed: CompletedMode;
  showSubIssues: boolean;
  showEmptyGroups: boolean;
  props: Record<PropKey, boolean>;
}

export interface Filters {
  status?: string[]; // "type:名前"
  priority?: number[];
  assignee?: string[]; // userId or "none"
  creator?: string[];
  label?: string[];
  project?: string[]; // projectId or "none"
  cycle?: string[]; // cycleId or "none"
  team?: string[];
}

export type FilterKey = keyof Filters;

export const DEFAULT_PROPS: Record<PropKey, boolean> = {
  id: true,
  status: true,
  priority: true,
  labels: true,
  project: true,
  cycle: false,
  dueDate: true,
  estimate: false,
  assignee: true,
  created: true,
};

export const DEFAULT_VIEW: ViewOptions = {
  layout: "list",
  grouping: "status",
  ordering: "priority",
  completed: "all",
  showSubIssues: true,
  showEmptyGroups: false,
  props: DEFAULT_PROPS,
};

/** 画面ごとに表示設定を保存する */
export function useViewState(key: string, defaults: Partial<ViewOptions> = {}) {
  const storageKey = `sen:view:${key}`;
  const [state, setState] = useState<{ key: string; view: ViewOptions; filters: Filters }>(() => load());
  function load() {
    const saved = readLocal<{ view?: Partial<ViewOptions>; filters?: Filters }>(storageKey, {});
    return {
      key,
      view: { ...DEFAULT_VIEW, ...defaults, ...saved.view, props: { ...DEFAULT_PROPS, ...defaults.props, ...saved.view?.props } },
      filters: saved.filters ?? {},
    };
  }
  // 画面（キー）が変わったら読み直す
  let current = state;
  if (state.key !== key) {
    current = load();
    setState(current);
  }
  const setView = useCallback(
    (patch: Partial<ViewOptions>) =>
      setState((s) => {
        const next = { ...s, view: { ...s.view, ...patch } };
        writeLocal(storageKey, { view: next.view, filters: next.filters });
        return next;
      }),
    [storageKey],
  );
  const setFilters = useCallback(
    (f: Filters) =>
      setState((s) => {
        const next = { ...s, filters: f };
        writeLocal(storageKey, { view: next.view, filters: next.filters });
        return next;
      }),
    [storageKey],
  );
  return { view: current.view, filters: current.filters, setView, setFilters };
}

type Ctx = Pick<DataState, "states" | "users" | "projects" | "cycles" | "labels" | "teams" | "meId">;

export function stateKey(type: StateType, name: string) {
  return `${type}:${name}`;
}

export function filterIssues(issues: Issue[], f: Filters, view: ViewOptions, ctx: Ctx): Issue[] {
  const now = Date.now();
  const has = <T>(arr: T[] | undefined) => arr && arr.length > 0;
  return issues.filter((i) => {
    if (i.archivedAt) return false;
    const st = ctx.states[i.stateId];
    if (!st) return false;
    if (!view.showSubIssues && i.parentId) return false;
    if (st.type === "completed" || st.type === "canceled") {
      const at = (st.type === "completed" ? i.completedAt : i.canceledAt) ?? i.updatedAt;
      if (view.completed === "none") return false;
      if (view.completed === "week" && now - at > 7 * 86400000) return false;
      if (view.completed === "month" && now - at > 30 * 86400000) return false;
    }
    if (has(f.status) && !f.status!.includes(stateKey(st.type, st.name))) return false;
    if (has(f.priority) && !f.priority!.includes(i.priority)) return false;
    if (has(f.assignee) && !f.assignee!.includes(i.assigneeId ?? "none")) return false;
    if (has(f.creator) && !f.creator!.includes(i.creatorId)) return false;
    if (has(f.project) && !f.project!.includes(i.projectId ?? "none")) return false;
    if (has(f.cycle) && !f.cycle!.includes(i.cycleId ?? "none")) return false;
    if (has(f.team) && !f.team!.includes(i.teamId)) return false;
    if (has(f.label)) {
      const want = f.label!;
      if (!(want.includes("none") && i.labelIds.length === 0) && !i.labelIds.some((l) => want.includes(l))) return false;
    }
    return true;
  });
}

export function sortIssues(list: Issue[], ordering: Ordering): Issue[] {
  const pr = (p: number) => PRIORITY_ORDER.indexOf(p);
  const arr = [...list];
  switch (ordering) {
    case "manual":
      return arr.sort((a, b) => a.sortOrder - b.sortOrder || b.createdAt - a.createdAt);
    case "priority":
      return arr.sort((a, b) => pr(a.priority) - pr(b.priority) || a.sortOrder - b.sortOrder || b.createdAt - a.createdAt);
    case "updated":
      return arr.sort((a, b) => b.updatedAt - a.updatedAt);
    case "created":
      return arr.sort((a, b) => b.createdAt - a.createdAt);
    case "dueDate":
      return arr.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || pr(a.priority) - pr(b.priority));
  }
}

export interface IssueGroup {
  key: string;
  label: string;
  kind: Grouping;
  /** アイコン描画用の値（stateId / userId / priority など） */
  value: string | number | null;
  issues: Issue[];
  /** このグループに新規作成するときの初期値 */
  defaults: CreateIssueDefaults;
  /** ボードのドロップ時に適用する変更（null = 移動不可） */
  patchFor: ((issue: Issue) => Partial<Issue>) | null;
}

export function groupIssues(
  issues: Issue[],
  view: ViewOptions,
  ctx: Ctx,
  opts: { teamId?: string | null; includeEmpty?: boolean; workflowOrder?: boolean; stateTypes?: StateType[] } = {},
): IssueGroup[] {
  const sorted = sortIssues(issues, view.ordering);
  const groups = new Map<string, IssueGroup>();
  const ensure = (g: Omit<IssueGroup, "issues">) => {
    if (!groups.has(g.key)) groups.set(g.key, { ...g, issues: [] });
    return groups.get(g.key)!;
  };
  const includeEmpty = opts.includeEmpty ?? view.showEmptyGroups;

  switch (view.grouping) {
    case "none": {
      return [{ key: "all", label: "すべての課題", kind: "none", value: null, issues: sorted, defaults: {}, patchFor: null }];
    }
    case "status": {
      // 1チームならそのチームのステータス、複数チームなら「種類:名前」でまとめる
      // リストは「いま動いているもの」を上に、ボードはワークフローの順に左から並べる
      const ACTIVE_FIRST: Record<StateType, number> = { started: 0, unstarted: 1, backlog: 2, completed: 3, canceled: 4 };
      let statesList = sortStates(
        Object.values(ctx.states).filter((s) => (!opts.teamId || s.teamId === opts.teamId) && (!opts.stateTypes || opts.stateTypes.includes(s.type))),
      );
      if (!opts.workflowOrder) statesList = [...statesList].sort((a, b) => ACTIVE_FIRST[a.type] - ACTIVE_FIRST[b.type] || a.position - b.position);
      if (opts.teamId) {
        for (const st of statesList)
          ensure({
            key: st.id,
            label: st.name,
            kind: "status",
            value: st.id,
            defaults: { stateId: st.id, teamId: opts.teamId },
            patchFor: () => ({ stateId: st.id }),
          });
        for (const i of sorted) groups.get(i.stateId)?.issues.push(i);
      } else {
        for (const st of statesList) {
          const k = stateKey(st.type, st.name);
          ensure({
            key: k,
            label: st.name,
            kind: "status",
            value: st.id,
            defaults: {},
            patchFor: (issue) => {
              const target = Object.values(ctx.states).find(
                (s) => s.teamId === issue.teamId && s.type === st.type && s.name === st.name,
              );
              const fallback = Object.values(ctx.states).find((s) => s.teamId === issue.teamId && s.type === st.type);
              return { stateId: (target ?? fallback ?? ctx.states[issue.stateId]).id };
            },
          });
        }
        for (const i of sorted) {
          const st = ctx.states[i.stateId];
          groups.get(stateKey(st.type, st.name))?.issues.push(i);
        }
      }
      break;
    }
    case "assignee": {
      const members = Object.values(ctx.users).sort((a, b) =>
        a.id === ctx.meId ? -1 : b.id === ctx.meId ? 1 : a.createdAt - b.createdAt,
      );
      for (const u of members)
        ensure({ key: u.id, label: u.name, kind: "assignee", value: u.id, defaults: { assigneeId: u.id }, patchFor: () => ({ assigneeId: u.id }) });
      ensure({ key: "none", label: "担当者なし", kind: "assignee", value: null, defaults: { assigneeId: null }, patchFor: () => ({ assigneeId: null }) });
      for (const i of sorted) groups.get(i.assigneeId ?? "none")?.issues.push(i);
      break;
    }
    case "priority": {
      for (const p of PRIORITY_ORDER)
        ensure({
          key: String(p),
          label: priorityLabel(p),
          kind: "priority",
          value: p,
          defaults: { priority: p },
          patchFor: () => ({ priority: p }),
        });
      for (const i of sorted) groups.get(String(i.priority))?.issues.push(i);
      break;
    }
    case "project": {
      for (const p of Object.values(ctx.projects).filter((p) => !p.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder))
        ensure({ key: p.id, label: p.name, kind: "project", value: p.id, defaults: { projectId: p.id }, patchFor: () => ({ projectId: p.id }) });
      ensure({ key: "none", label: "プロジェクトなし", kind: "project", value: null, defaults: { projectId: null }, patchFor: () => ({ projectId: null }) });
      for (const i of sorted) groups.get(i.projectId ?? "none")?.issues.push(i);
      break;
    }
    case "cycle": {
      for (const c of Object.values(ctx.cycles)
        .filter((c) => !opts.teamId || c.teamId === opts.teamId)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)))
        ensure({
          key: c.id,
          label: `${ctx.teams[c.teamId]?.key ?? ""} ${cycleName(c)}`.trim(),
          kind: "cycle",
          value: c.id,
          defaults: { cycleId: c.id, teamId: c.teamId },
          patchFor: (issue) => (issue.teamId === c.teamId ? { cycleId: c.id } : {}),
        });
      ensure({ key: "none", label: "サイクルなし", kind: "cycle", value: null, defaults: { cycleId: null }, patchFor: () => ({ cycleId: null }) });
      for (const i of sorted) groups.get(i.cycleId ?? "none")?.issues.push(i);
      break;
    }
    case "label": {
      for (const l of Object.values(ctx.labels).sort((a, b) => a.name.localeCompare(b.name, "ja")))
        ensure({ key: l.id, label: l.name, kind: "label", value: l.id, defaults: { labelIds: [l.id] }, patchFor: null });
      ensure({ key: "none", label: "ラベルなし", kind: "label", value: null, defaults: {}, patchFor: null });
      for (const i of sorted) {
        if (!i.labelIds.length) groups.get("none")?.issues.push(i);
        else i.labelIds.forEach((l) => groups.get(l)?.issues.push(i));
      }
      break;
    }
  }
  const out = [...groups.values()];
  return includeEmpty ? out : out.filter((g) => g.issues.length > 0);
}

export function activeFilterCount(f: Filters): number {
  return Object.values(f).filter((v) => Array.isArray(v) && v.length > 0).length;
}
