import { useCallback, useMemo } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import type { Issue, Project } from "../../../shared/types";
import { useData } from "../../store/data";
import { openCreateIssue } from "../../store/ui";
import { useViewState, type IssueGroup } from "../../store/view";
import { Button } from "../../components/ui";
import { useWsPath } from "../../app/hooks";
import { IssueList } from "../issues/IssueList";
import { useIssueGroups } from "../issues/useIssueGroups";

const OVERVIEW_FILTERS = {};

/** 概要タブにだけ置く。ProjectPage はタブをまたいで残るので、ここで表示設定を読み直す */
export function ProjectIssues({ project, issues }: { project: Project; issues: Issue[] }) {
  const p = useWsPath();
  const states = useData((s) => s.states);
  const { view } = useViewState(`project:${project.id}`);
  const overviewView = useMemo(
    () => ({
      ...view,
      layout: "list" as const,
      grouping: "status" as const,
      completed: "all" as const,
      showEmptyGroups: false,
      props: { ...view.props, project: false },
    }),
    [view],
  );
  const { filtered, groups } = useIssueGroups(issues, overviewView, OVERVIEW_FILTERS);
  const defaultCollapsed = useCallback(
    (group: IssueGroup) => {
      if (group.kind !== "status") return false;
      const type = states[String(group.value)]?.type;
      return type === "completed" || type === "canceled";
    },
    [states],
  );

  return (
    <section className="project-issues" data-testid="project-issues">
      <div className="project-issues-head">
        <span className="project-issues-title">課題</span>
        <span className="project-issues-count">{filtered.length}</span>
        <span className="spacer" />
        <Link to={p(`/project/${project.id}/issues`)} className="link-btn" data-testid="project-issues-open-tab">
          課題タブで開く →
        </Link>
        <Button
          size="sm"
          icon={<Plus size={14} />}
          data-testid="project-issues-add"
          onClick={() => openCreateIssue({ projectId: project.id, teamId: project.teamIds[0] })}
        >
          課題を追加
        </Button>
      </div>
      <IssueList
        variant="embedded"
        groups={groups}
        view={overviewView}
        listKey={`project-overview:${project.id}`}
        listLabel={`${project.name} の課題`}
        createDefaults={{ projectId: project.id, teamId: project.teamIds[0] }}
        defaultCollapsed={defaultCollapsed}
        empty={
          <div className="project-issues-empty" data-testid="project-issues-empty">
            このプロジェクトにはまだ課題がありません
          </div>
        }
      />
    </section>
  );
}
