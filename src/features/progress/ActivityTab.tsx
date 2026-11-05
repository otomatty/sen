import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ChartColumn } from "lucide-react";
import type { ProgressActivity } from "../../../shared/progress";
import { useUI } from "../../store/ui";
import { cx } from "../../lib/utils";
import { Button, EmptyState } from "../../components/ui";
import { ProjectIcon } from "../../components/icons";
import { useWsPath } from "../../app/hooks";
import type { ProgressModel } from "./useProgress";
import { ActivityBadge, CompletionRate, NextDue } from "./parts";

const FILTERS = ["すべて", "期限超過", "保留あり", "進行中", "未着手", "完了", "タスク未登録"] as const;
type ActivityFilter = (typeof FILTERS)[number];

export function ActivityTab({ model }: { model: ProgressModel }) {
  const { activities, today } = model;
  const [filter, setFilter] = useState<ActivityFilter>("すべて");
  const counts = useMemo(() => {
    const out: Record<ActivityFilter, number> = {
      すべて: activities.length,
      期限超過: 0,
      保留あり: 0,
      進行中: 0,
      未着手: 0,
      完了: 0,
      タスク未登録: 0,
    };
    for (const activity of activities) out[activity.status]++;
    return out;
  }, [activities]);
  const shown = filter === "すべて" ? activities : activities.filter((activity) => activity.status === filter);
  const done = activities.reduce((sum, activity) => sum + activity.done, 0);
  const total = activities.reduce((sum, activity) => sum + activity.total, 0);
  const todayLabel = today.replaceAll("-", "/");

  if (activities.length === 0) {
    return (
      <>
        <NoProjects />
        <p className="progress-note">数え方はスプレッドシートと同じです（キャンセル・重複は数えない、バックログは「保留」）。</p>
      </>
    );
  }

  return (
    <>
      <div className="progress-cards">
        <Stat label="活動" value={String(activities.length)} hint="アーカイブしていないプロジェクト" />
        <Stat
          label="タスク"
          value={
            <>
              {done}/{total}
              <span className="progress-stat-suffix">完了</span>
            </>
          }
          hint="キャンセル・重複は数えない"
        />
        <Stat label="期限超過" value={String(counts["期限超過"])} hint={`今日の日付 ${todayLabel}`} tone={counts["期限超過"] > 0 ? "danger" : undefined} />
        <Stat label="保留あり" value={String(counts["保留あり"])} hint="バックログの課題が残っている活動" tone={counts["保留あり"] > 0 ? "warn" : undefined} />
      </div>
      <div className="progress-filters">
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className={cx("chip-btn", filter === key && "on")}
            aria-pressed={filter === key}
            data-testid={`progress-filter-${key}`}
            onClick={() => setFilter(key)}
          >
            {key}
            <span className="progress-filter-count">{counts[key]}</span>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="progress-empty">この状況の活動はありません</p>
      ) : (
        <div className="progress-scroll">
          <div className="table progress-table" role="table">
            <div className="table-head" role="row">
              <span>活動</span>
              <span>直近期限</span>
              <span>完了率</span>
              <span>活動状況</span>
            </div>
            {shown.map((activity) => (
              <ActivityRow key={activity.projectId} activity={activity} model={model} />
            ))}
          </div>
        </div>
      )}
      <p className="progress-note">数え方はスプレッドシートと同じです（キャンセル・重複は数えない、バックログは「保留」）。</p>
    </>
  );
}

function ActivityRow({ activity, model }: { activity: ProgressActivity; model: ProgressModel }) {
  const project = model.projects[activity.projectId];
  const p = useWsPath();
  const color = project?.color ?? "var(--accent)";
  return (
    <div className="table-row" role="row" data-testid="progress-activity-row" data-project-id={activity.projectId}>
      <Link to={p(`/project/${activity.projectId}`)} className="cell-name progress-activity-link">
        <ProjectIcon color={color} status={project?.status} size={16} />
        <b>{activity.name}</b>
      </Link>
      <span>
        <NextDue activity={activity} testId="progress-due" />
      </span>
      <span>
        <CompletionRate activity={activity} color={color} testId="progress-rate" />
      </span>
      <span>
        <ActivityBadge status={activity.status} testId="progress-status" />
      </span>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint: string; tone?: "danger" | "warn" }) {
  return (
    <div className={cx("progress-stat", tone === "danger" && "is-danger", tone === "warn" && "is-warn")}>
      <div className="progress-stat-label">{label}</div>
      <div className="progress-stat-value">{value}</div>
      <div className="progress-stat-hint">{hint}</div>
    </div>
  );
}

function NoProjects() {
  const navigate = useNavigate();
  const p = useWsPath();
  return (
    <EmptyState
      icon={<ChartColumn size={28} />}
      title="プロジェクトはありません"
      description="活動の進捗は、アーカイブしていないプロジェクトごとに集計されます。"
      action={
        <Button
          variant="primary"
          onClick={() => {
            useUI.setState({ projectCreateOpen: true });
            navigate(p("/projects"));
          }}
        >
          プロジェクトを作成
        </Button>
      }
    />
  );
}
