import { Navigate, NavLink, useParams } from "react-router";
import { ChartColumn, ExternalLink } from "lucide-react";
import { cx } from "../../lib/utils";
import { PageHeader } from "../../components/PageHeader";
import { useDocumentTitle, useWsPath } from "../../app/hooks";
import { useProgress } from "./useProgress";
import { ActivityTab } from "./ActivityTab";
import { WbsTab } from "./WbsTab";
import { TimelineTab } from "./TimelineTab";

export function ProgressPage() {
  const { tab } = useParams();
  const p = useWsPath();
  const model = useProgress();
  useDocumentTitle("進捗");
  if (tab && tab !== "wbs" && tab !== "timeline") return <Navigate to={p("/progress")} replace />;

  return (
    <div className="page progress-page" data-testid="progress-page">
      <PageHeader
        title={
          <span className="page-title-text">
            <ChartColumn size={16} />
            進捗
          </span>
        }
        screen="progress"
        actions={
          <>
            <span className="progress-live">自動で最新の状態に更新</span>
            {model.sheetUrl && (
              <a className="toolbar-btn" href={model.sheetUrl} target="_blank" rel="noopener noreferrer" data-testid="progress-open-sheet">
                <ExternalLink size={13} />
                スプレッドシートを開く
              </a>
            )}
          </>
        }
      >
        <nav className="tabs">
          <NavLink end to={p("/progress")} className={({ isActive }) => cx("tab", isActive && "active")} data-testid="progress-tab-overview">
            活動一覧
          </NavLink>
          <NavLink to={p("/progress/wbs")} className={({ isActive }) => cx("tab", isActive && "active")} data-testid="progress-tab-wbs">
            WBS
          </NavLink>
          <NavLink to={p("/progress/timeline")} className={({ isActive }) => cx("tab", isActive && "active")} data-testid="progress-tab-timeline">
            タイムライン
          </NavLink>
        </nav>
      </PageHeader>
      <div className="page-body progress-body">
        {tab === "wbs" ? <WbsTab model={model} /> : tab === "timeline" ? <TimelineTab model={model} /> : <ActivityTab model={model} />}
      </div>
    </div>
  );
}
