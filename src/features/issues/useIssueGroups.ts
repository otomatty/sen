import { useMemo } from "react";
import type { Issue, StateType } from "../../../shared/types";
import { useData } from "../../store/data";
import { filterIssues, groupIssues, type Filters, type IssueGroup, type ViewOptions } from "../../store/view";

/** 課題一覧とボードで共通の、絞り込みとグループ分け */
export function useIssueGroups(
  issues: Issue[],
  view: ViewOptions,
  filters: Filters,
  opts?: { teamId?: string | null; stateTypes?: StateType[] },
): { filtered: Issue[]; groups: IssueGroup[] } {
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const projects = useData((s) => s.projects);
  const cycles = useData((s) => s.cycles);
  const labels = useData((s) => s.labels);
  const teams = useData((s) => s.teams);
  const meId = useData((s) => s.meId);
  const ctx = useMemo(
    () => ({ states, users, projects, cycles, labels, teams, meId }),
    [states, users, projects, cycles, labels, teams, meId],
  );
  const teamId = opts?.teamId;
  const stateTypes = opts?.stateTypes;

  const filtered = useMemo(() => filterIssues(issues, filters, view, ctx), [issues, filters, view, ctx]);
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
  return { filtered, groups };
}
