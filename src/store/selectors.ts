import { useMemo } from "react";
import type { Activity, AppNotification, Comment, Cycle, Issue, Label, Project, Team, User, WorkflowState } from "../../shared/types";
import { STATE_TYPE_ORDER } from "../../shared/constants";
import { localYmd } from "../lib/utils";
import { useData } from "./data";

export function useTeams(): Team[] {
  const teams = useData((s) => s.teams);
  return useMemo(() => Object.values(teams).sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key)), [teams]);
}

export function useTeamByKey(key: string | undefined): Team | undefined {
  const teams = useData((s) => s.teams);
  return useMemo(() => Object.values(teams).find((t) => t.key.toLowerCase() === key?.toLowerCase()), [teams, key]);
}

export function sortStates(list: WorkflowState[]): WorkflowState[] {
  return [...list].sort((a, b) => STATE_TYPE_ORDER[a.type] - STATE_TYPE_ORDER[b.type] || a.position - b.position);
}

export function useStates(teamId?: string | null): WorkflowState[] {
  const states = useData((s) => s.states);
  return useMemo(
    () => sortStates(Object.values(states).filter((s) => !teamId || s.teamId === teamId)),
    [states, teamId],
  );
}

export function useLabels(): Label[] {
  const labels = useData((s) => s.labels);
  return useMemo(() => Object.values(labels).sort((a, b) => a.name.localeCompare(b.name, "ja")), [labels]);
}

export function useMembers(): User[] {
  const users = useData((s) => s.users);
  return useMemo(() => Object.values(users).sort((a, b) => a.createdAt - b.createdAt), [users]);
}

export function useProjects(): Project[] {
  const projects = useData((s) => s.projects);
  return useMemo(
    () => Object.values(projects).filter((p) => !p.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder),
    [projects],
  );
}

export function useCycles(teamId?: string | null): Cycle[] {
  const cycles = useData((s) => s.cycles);
  return useMemo(
    () => Object.values(cycles).filter((c) => !teamId || c.teamId === teamId).sort((a, b) => a.number - b.number),
    [cycles, teamId],
  );
}

export function cycleStatus(c: Cycle, today = localYmd()): "past" | "current" | "upcoming" {
  if (c.endsAt < today) return "past";
  if (c.startsAt > today) return "upcoming";
  return "current";
}

export function cycleName(c: Cycle): string {
  return c.name || `サイクル ${c.number}`;
}

export function useActiveIssues(): Issue[] {
  const issues = useData((s) => s.issues);
  return useMemo(() => Object.values(issues).filter((i) => !i.archivedAt), [issues]);
}

export function useIssue(id: string | null | undefined): Issue | undefined {
  return useData((s) => (id ? s.issues[id] : undefined));
}

export function useIssueByIdentifier(identifier: string | undefined): Issue | undefined {
  const issues = useData((s) => s.issues);
  const teams = useData((s) => s.teams);
  return useMemo(() => {
    if (!identifier) return undefined;
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier);
    if (!m) return undefined;
    const team = Object.values(teams).find((t) => t.key.toLowerCase() === m[1].toLowerCase());
    if (!team) return undefined;
    const n = Number(m[2]);
    return Object.values(issues).find((i) => i.teamId === team.id && i.number === n);
  }, [issues, teams, identifier]);
}

export function useSubIssues(parentId: string | null | undefined): Issue[] {
  const issues = useData((s) => s.issues);
  const states = useData((s) => s.states);
  return useMemo(() => {
    if (!parentId) return [];
    return Object.values(issues)
      .filter((i) => i.parentId === parentId && !i.archivedAt)
      .sort(
        (a, b) =>
          STATE_TYPE_ORDER[states[a.stateId]?.type ?? "backlog"] - STATE_TYPE_ORDER[states[b.stateId]?.type ?? "backlog"] ||
          a.number - b.number,
      );
  }, [issues, states, parentId]);
}

export type ThreadItem = { kind: "comment"; at: number; item: Comment } | { kind: "activity"; at: number; item: Activity };

export function useThread(issueId: string): ThreadItem[] {
  const comments = useData((s) => s.comments);
  const activities = useData((s) => s.activities);
  return useMemo(() => {
    const out: ThreadItem[] = [];
    for (const c of Object.values(comments)) if (c.issueId === issueId) out.push({ kind: "comment", at: c.createdAt, item: c });
    for (const a of Object.values(activities)) if (a.issueId === issueId) out.push({ kind: "activity", at: a.createdAt, item: a });
    return out.sort((a, b) => a.at - b.at);
  }, [comments, activities, issueId]);
}

export function useInbox(): AppNotification[] {
  const notifications = useData((s) => s.notifications);
  const issues = useData((s) => s.issues);
  return useMemo(() => {
    const now = Date.now();
    return Object.values(notifications)
      .filter((n) => !n.archivedAt && issues[n.issueId] && !(n.snoozedUntil && n.snoozedUntil > now))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [notifications, issues]);
}

export function useUnreadCount(): number {
  const inbox = useInbox();
  return useMemo(() => inbox.filter((n) => !n.readAt).length, [inbox]);
}

export function projectProgress(projectId: string, issues: Issue[], states: Record<string, WorkflowState>) {
  const list = issues.filter((i) => i.projectId === projectId && !i.archivedAt);
  let done = 0;
  let started = 0;
  let canceled = 0;
  for (const i of list) {
    const t = states[i.stateId]?.type;
    if (t === "completed") done++;
    else if (t === "started") started++;
    else if (t === "canceled") canceled++;
  }
  const total = list.length - canceled;
  return { total, done, started, percent: total ? Math.round((done / total) * 100) : 0 };
}

// ---------------------------------------------------------------------------
// 課題どうしの関係
// ---------------------------------------------------------------------------
export type RelationView = "blocks" | "blockedBy" | "related" | "duplicate" | "duplicatedBy";

export interface RelationEntry {
  kind: RelationView;
  issue: Issue;
}

const FORWARD: Record<string, RelationView> = { blocks: "blocks", related: "related", duplicate: "duplicate" };
const BACKWARD: Record<string, RelationView> = { blocks: "blockedBy", related: "related", duplicate: "duplicatedBy" };

/** 課題から見たすべての関係（相手側に保存されている逆向きの関係も含む） */
export function computeRelations(issues: Record<string, Issue>, issueId: string): RelationEntry[] {
  const self = issues[issueId];
  if (!self) return [];
  const out: RelationEntry[] = [];
  const seen = new Set<string>();
  for (const r of self.relations ?? []) {
    const other = issues[r.issueId];
    if (!other || other.archivedAt || seen.has(other.id)) continue;
    seen.add(other.id);
    out.push({ kind: FORWARD[r.type], issue: other });
  }
  for (const other of Object.values(issues)) {
    if (other.archivedAt || other.id === issueId || seen.has(other.id)) continue;
    const r = (other.relations ?? []).find((x) => x.issueId === issueId);
    if (r) {
      seen.add(other.id);
      out.push({ kind: BACKWARD[r.type], issue: other });
    }
  }
  return out;
}

export function useIssueRelations(issueId: string): RelationEntry[] {
  const issues = useData((s) => s.issues);
  return useMemo(() => computeRelations(issues, issueId), [issues, issueId]);
}

/** 未完了の課題にブロックされている課題 → ブロックしている課題の ID（issues が変わるまで使い回す） */
let blockedCache: { issues: Record<string, Issue>; states: Record<string, WorkflowState>; map: Map<string, string[]> } | null = null;

export function blockedMap(issues: Record<string, Issue>, states: Record<string, WorkflowState>): Map<string, string[]> {
  if (blockedCache && blockedCache.issues === issues && blockedCache.states === states) return blockedCache.map;
  const map = new Map<string, string[]>();
  for (const i of Object.values(issues)) {
    if (i.archivedAt || !i.relations?.length) continue;
    const t = states[i.stateId]?.type;
    if (t === "completed" || t === "canceled") continue;
    for (const r of i.relations) {
      if (r.type !== "blocks") continue;
      const target = issues[r.issueId];
      if (!target || target.archivedAt) continue;
      const list = map.get(r.issueId);
      if (list) list.push(i.id);
      else map.set(r.issueId, [i.id]);
    }
  }
  blockedCache = { issues, states, map };
  return map;
}

/** この課題をブロックしている未完了の課題の数（行の表示用。数が変わったときだけ再描画される） */
export function useBlockerCount(issueId: string): number {
  return useData((s) => blockedMap(s.issues, s.states).get(issueId)?.length ?? 0);
}
