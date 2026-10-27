import { CalendarDays, Hash } from "lucide-react";
import type { Issue } from "../../../shared/types";
import { useData } from "../../store/data";
import { cycleName } from "../../store/selectors";
import { cx, dueStatus, formatDate } from "../../lib/utils";
import { CycleIcon, LabelDot, ProjectIcon } from "../../components/icons";

export function LabelChips({ ids, max = 3 }: { ids: string[]; max?: number }) {
  const labels = useData((s) => s.labels);
  const list = ids.map((id) => labels[id]).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  return (
    <span className="label-chips">
      {shown.map((l) => (
        <span key={l.id} className="chip label-chip" title={l.name}>
          <LabelDot color={l.color} />
          <span className="chip-text">{l.name}</span>
        </span>
      ))}
      {list.length > max && <span className="chip label-chip">+{list.length - max}</span>}
    </span>
  );
}

export function ProjectChip({ projectId }: { projectId: string | null }) {
  const project = useData((s) => (projectId ? s.projects[projectId] : undefined));
  if (!project || project.archivedAt) return null;
  return (
    <span className="chip project-chip" title={project.name}>
      <ProjectIcon color={project.color} status={project.status} size={12} />
      <span className="chip-text">{project.name}</span>
    </span>
  );
}

export function CycleChip({ cycleId }: { cycleId: string | null }) {
  const cycle = useData((s) => (cycleId ? s.cycles[cycleId] : undefined));
  if (!cycle) return null;
  return (
    <span className="chip" title={cycleName(cycle)}>
      <CycleIcon size={12} progress={0.5} />
      <span className="chip-text">{cycleName(cycle)}</span>
    </span>
  );
}

export function DueChip({ due, done }: { due: string | null; done?: boolean }) {
  if (!due) return null;
  const st = done ? "normal" : dueStatus(due);
  return (
    <span className={cx("chip due-chip", st)} title={`期日：${formatDate(due, true)}`}>
      <CalendarDays size={12} />
      <span className="chip-text">{formatDate(due)}</span>
    </span>
  );
}

export function EstimateChip({ estimate }: { estimate: number | null }) {
  if (estimate === null || estimate === undefined) return null;
  return (
    <span className="chip estimate-chip" title={`見積もり：${estimate} ポイント`}>
      <Hash size={11} />
      {estimate}
    </span>
  );
}

// 行ごとに全課題を走査しないよう、親ごとの集計をキャッシュする
let cache: { issues: unknown; states: unknown; map: Map<string, { total: number; done: number }> } | null = null;
function subCounts(issues: Record<string, Issue>, states: Record<string, { type: string }>) {
  if (cache && cache.issues === issues && cache.states === states) return cache.map;
  const map = new Map<string, { total: number; done: number }>();
  for (const i of Object.values(issues)) {
    if (!i.parentId || i.archivedAt) continue;
    const e = map.get(i.parentId) ?? { total: 0, done: 0 };
    e.total++;
    if (states[i.stateId]?.type === "completed") e.done++;
    map.set(i.parentId, e);
  }
  cache = { issues, states, map };
  return map;
}

export function SubIssueCount({ issue }: { issue: Issue }) {
  const issues = useData((s) => s.issues);
  const states = useData((s) => s.states);
  const c = subCounts(issues, states).get(issue.id);
  if (!c) return null;
  const { done, total } = c;
  return (
    <span className="chip sub-count" title={`サブ課題 ${done}/${total}`}>
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
        <path d="M4 2v7.5A2.5 2.5 0 0 0 6.5 12H12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M9.5 9.5 12 12l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      {done}/{total}
    </span>
  );
}
