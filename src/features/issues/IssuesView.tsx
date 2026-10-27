import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Layers } from "lucide-react";
import type { Issue, StateType } from "../../../shared/types";
import { useData } from "../../store/data";
import { filterIssues, groupIssues, useViewState, type FilterKey, type Filters, type ViewOptions } from "../../store/view";
import { openCreateIssue } from "../../store/ui";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { Button, EmptyState, Kbd } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import type { ScreenKey } from "../help/tutorials";
import { IssueList } from "./IssueList";
const IssueBoard = lazy(() => import("./IssueBoard").then((m) => ({ default: m.IssueBoard })));
import { DisplayButton, FilterButton, FilterChips } from "./ViewControls";

export function IssuesView({
  viewKey,
  issues,
  title,
  tabs,
  listLabel,
  teamId,
  filterFields,
  defaults,
  baseFilters,
  createDefaults,
  screen = "issues",
  emptyTitle = "課題はありません",
  emptyDescription,
  headerExtra,
  stateTypes,
}: {
  viewKey: string;
  issues: Issue[];
  title: ReactNode;
  tabs?: ReactNode;
  listLabel: string;
  teamId?: string | null;
  filterFields?: FilterKey[];
  defaults?: Partial<ViewOptions>;
  baseFilters?: Filters;
  createDefaults?: Parameters<typeof openCreateIssue>[0];
  screen?: ScreenKey;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  headerExtra?: ReactNode;
  /** この画面に出るステータスの種類（アクティブ・バックログのタブ）。ボードの空の列もこれで絞る */
  stateTypes?: StateType[];
}) {
  const { view, filters, setView, setFilters } = useViewState(viewKey, defaults);
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const projects = useData((s) => s.projects);
  const cycles = useData((s) => s.cycles);
  const labels = useData((s) => s.labels);
  const teams = useData((s) => s.teams);
  const meId = useData((s) => s.meId);
  const ctx = useMemo(() => ({ states, users, projects, cycles, labels, teams, meId }), [states, users, projects, cycles, labels, teams, meId]);

  const filtered = useMemo(
    () => filterIssues(issues, { ...filters, ...baseFilters }, view, ctx),
    [issues, filters, baseFilters, view, ctx],
  );
  const groups = useMemo(
    () =>
      groupIssues(filtered, view, ctx, {
        teamId,
        includeEmpty: view.layout === "board" && view.grouping === "status" ? true : undefined,
        workflowOrder: view.layout === "board",
        stateTypes,
      }),
    [filtered, view, ctx, teamId, stateTypes],
  );

  useHotkeys("mod+b", () => setView({ layout: view.layout === "list" ? "board" : "list" }), { scope: SCOPE.view });
  // コマンドパレットからの切り替え
  useEffect(() => {
    const fn = () => setView({ layout: view.layout === "list" ? "board" : "list" });
    window.addEventListener("sen:toggle-layout", fn);
    return () => window.removeEventListener("sen:toggle-layout", fn);
  }, [view.layout, setView]);

  const fields: FilterKey[] = filterFields ?? (teamId ? ["status", "priority", "assignee", "label", "project", "cycle", "creator"] : ["status", "priority", "assignee", "label", "project", "team", "creator"]);
  const empty = (
    <EmptyState
      icon={<Layers size={28} />}
      title={filtered.length === 0 && issues.length > 0 ? "条件に一致する課題はありません" : emptyTitle}
      description={
        filtered.length === 0 && issues.length > 0 ? "フィルターを変更するか、クリアしてください。" : emptyDescription ?? (
          <>
            <Kbd combo="c" /> を押すと新しい課題を作成できます。
          </>
        )
      }
      action={
        filtered.length === 0 && issues.length > 0 ? (
          <Button onClick={() => setFilters({})}>フィルターをクリア</Button>
        ) : (
          <Button variant="primary" onClick={() => openCreateIssue({ teamId: teamId ?? undefined, ...createDefaults })}>
            課題を作成
          </Button>
        )
      }
    />
  );

  return (
    <div className="page issues-page" data-testid="issues-view" data-layout={view.layout}>
      <PageHeader
        title={title}
        screen={view.layout === "board" ? "board" : screen}
        actions={
          <>
            {headerExtra}
            <FilterButton filters={filters} setFilters={setFilters} teamId={teamId} fields={fields} />
            <DisplayButton view={view} setView={setView} allowCycle={!!teamId} />
          </>
        }
      >
        {tabs}
      </PageHeader>
      <FilterChips filters={filters} setFilters={setFilters} teamId={teamId} />
      <div className={view.layout === "board" ? "page-body board-body" : "page-body"}>
        {view.layout === "board" ? (
          filtered.length === 0 && issues.length > 0 ? (
            empty
          ) : (
            <Suspense fallback={null}>
              <IssueBoard groups={groups} view={view} listLabel={listLabel} teamId={teamId} />
            </Suspense>
          )
        ) : (
          <IssueList groups={groups} view={view} listKey={viewKey} listLabel={listLabel} teamId={teamId} empty={empty} />
        )}
      </div>
    </div>
  );
}
