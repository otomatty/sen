import type { ActivityStatus, ProgressActivity, ProgressTask } from "../../../shared/progress";

export function slashDate(ymd: string | null | undefined): string | null {
  return ymd ? ymd.replaceAll("-", "/") : null;
}

/** 保留でない未完了で、期限が今日より前 */
export function isTaskOverdue(task: Pick<ProgressTask, "stateType" | "dueDate">, today: string): boolean {
  return task.stateType !== "completed" && task.stateType !== "canceled" && task.stateType !== "backlog" && !!task.dueDate && task.dueDate < today;
}

export function ActivityBadge({ status, testId }: { status: ActivityStatus; testId?: string }) {
  return (
    <span className="progress-badge" data-status={status} data-testid={testId}>
      {status}
    </span>
  );
}

export function CompletionRate({ activity, color, testId }: { activity: ProgressActivity; color: string; testId?: string }) {
  if (activity.percent == null) {
    return (
      <span className="progress-rate" data-testid={testId}>
        {activity.completionRate}
      </span>
    );
  }
  return (
    <span className="progress-rate" data-testid={testId}>
      <span className="progress-bar thin" aria-hidden>
        <span style={{ width: `${activity.percent}%`, background: color }} />
      </span>
      <span className="progress-rate-text">
        <span>{activity.percent}%</span><span className="progress-rate-frac">（{activity.done}/{activity.total}）</span>
      </span>
    </span>
  );
}

export function NextDue({ activity, testId }: { activity: ProgressActivity; testId?: string }) {
  if (!activity.nextDueDate) {
    return (
      <span className="muted" data-testid={testId}>
        {activity.nextDue}
      </span>
    );
  }
  const date = slashDate(activity.nextDueDate);
  return (
    <span className="progress-due" data-testid={testId}>
      <span>{date}</span>
      {activity.nextDueUnset > 0 && <span className="progress-unset">未設定 {activity.nextDueUnset} 件</span>}
    </span>
  );
}
