import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ProgressActivity, ProgressTask } from "../../../shared/progress";
import { cx, readLocal, writeLocal } from "../../lib/utils";
import { useWsPath } from "../../app/hooks";
import { useData } from "../../store/data";
import { Avatar, Menu, Switch } from "../../components/ui";
import { PriorityIcon, ProjectIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import type { ProgressModel } from "./useProgress";
import { ActivityBadge, CompletionRate, NextDue, isTaskOverdue, slashDate } from "./parts";

type AssigneeFilter = "all" | "me" | "none" | string;

export function WbsTab({ model }: { model: ProgressModel }) {
  const { activities, today, members, meId, assigneeIdByIssue } = model;
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [process, setProcess] = useState("all");
  const [showDone, setShowDone] = useState(true);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [collapsed, setCollapsed] = useCollapsed(wsKey);
  const processes = useMemo(() => {
    const names = new Set<string>();
    for (const activity of activities) for (const task of activity.tasks) for (const name of task.processes) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b, "ja"));
  }, [activities]);

  const assigneeLabel =
    assignee === "all" ? "すべて" : assignee === "me" ? "自分" : assignee === "none" ? "未割り当て" : (members.find((member) => member.id === assignee)?.name ?? "すべて");
  const processLabel = process === "all" ? "すべて" : process === "none" ? "工程なし" : process;
  const toggle = (projectId: string) => {
    const next = new Set(collapsed);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    setCollapsed(next);
    writeLocal(collapsedKey(wsKey), [...next]);
  };

  return (
    <>
      <div className="wbs-toolbar">
        <FilterMenu
          testId="wbs-filter-assignee"
          label="担当"
          value={assigneeLabel}
          options={[
            { id: "all", label: "すべて" },
            { id: "me", label: "自分" },
            { id: "none", label: "未割り当て" },
            ...members.map((member) => ({ id: member.id, label: member.name })),
          ]}
          onChange={setAssignee}
        />
        <FilterMenu
          testId="wbs-filter-process"
          label="工程"
          value={processLabel}
          options={[{ id: "all", label: "すべて" }, { id: "none", label: "工程なし" }, ...processes.map((name) => ({ id: name, label: name }))]}
          onChange={setProcess}
        />
        <span className="wbs-toggle">
          <Switch id="wbs-done-switch" checked={showDone} onChange={setShowDone} label="完了も表示" testId="wbs-toggle-done" />
          <label htmlFor="wbs-done-switch">完了も表示</label>
        </span>
        <span className="wbs-toggle">
          <Switch id="wbs-overdue-switch" checked={overdueOnly} onChange={setOverdueOnly} label="期限超過だけ" testId="wbs-toggle-overdue" />
          <label htmlFor="wbs-overdue-switch">期限超過だけ</label>
        </span>
        <span className="wbs-toolbar-note">まとめ方：活動 ・ 並び：完了予定が早い順</span>
      </div>
      {activities.length === 0 ? (
        <p className="progress-empty">プロジェクトはありません</p>
      ) : (
        <div className="progress-scroll">
          <div className="wbs-sheet">
            <div className="wbs-head">
              <span>工程</span>
              <span>作業</span>
              <span>担当</span>
              <span>着手日</span>
              <span>完了予定</span>
              <span>状態</span>
              <span>完了日</span>
              <span>優先度</span>
            </div>
            {activities.map((activity) => (
              <WbsGroup
                key={activity.projectId}
                activity={activity}
                model={model}
                collapsed={collapsed.has(activity.projectId)}
                onToggle={() => toggle(activity.projectId)}
                rows={activity.tasks.filter((task) =>
                  matches(task, { assignee, process, showDone, overdueOnly, today, meId, assigneeIdByIssue }),
                )}
              />
            ))}
          </div>
        </div>
      )}
      <p className="progress-note">行を押すと課題を開きます。</p>
    </>
  );
}

function matches(
  task: ProgressTask,
  opts: {
    assignee: AssigneeFilter;
    process: string;
    showDone: boolean;
    overdueOnly: boolean;
    today: string;
    meId: string | null;
    assigneeIdByIssue: Map<string, string | null>;
  },
): boolean {
  if (!opts.showDone && task.stateType === "completed") return false;
  if (opts.overdueOnly && !isTaskOverdue(task, opts.today)) return false;
  if (opts.process === "none") {
    if (task.processes.length > 0) return false;
  } else if (opts.process !== "all" && !task.processes.includes(opts.process)) return false;
  const assigneeId = opts.assigneeIdByIssue.get(task.id) ?? null;
  if (opts.assignee === "none") return assigneeId == null;
  if (opts.assignee === "me") return assigneeId != null && assigneeId === opts.meId;
  if (opts.assignee !== "all") return assigneeId === opts.assignee;
  return true;
}

function WbsGroup({
  activity,
  model,
  rows,
  collapsed,
  onToggle,
}: {
  activity: ProgressActivity;
  model: ProgressModel;
  rows: ProgressTask[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const project = model.projects[activity.projectId];
  const p = useWsPath();
  const color = project?.color ?? "var(--accent)";
  return (
    <section className="wbs-group" data-testid="wbs-group" data-project-id={activity.projectId}>
      <div className="wbs-group-head">
        <button
          type="button"
          className="icon-btn"
          aria-expanded={!collapsed}
          aria-label={`${activity.name}を${collapsed ? "開く" : "閉じる"}`}
          data-testid="wbs-group-toggle"
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <span className="wbs-swatch" style={{ background: color }} />
        <Link to={p(`/project/${activity.projectId}`)} className="wbs-project-link">
          <ProjectIcon color={color} status={project?.status} size={14} />
          <span className="truncate">{activity.name}</span>
        </Link>
        <span className="wbs-count">{rows.length} 件</span>
        <CompletionRate activity={activity} color={color} />
        <span className="wbs-next-due">
          <span className="muted">直近期限</span>
          <NextDue activity={activity} />
        </span>
        <ActivityBadge status={activity.status} />
      </div>
      {!collapsed &&
        (activity.tasks.length === 0 ? null : rows.length === 0 ? (
          <p className="wbs-empty">条件に合う作業はありません</p>
        ) : (
          rows.map((task) => <WbsRow key={task.id} task={task} model={model} today={model.today} />)
        ))}
    </section>
  );
}

function WbsRow({ task, model, today }: { task: ProgressTask; model: ProgressModel; today: string }) {
  const p = useWsPath();
  const issue = model.issues[task.id];
  const user = issue?.assigneeId ? model.users[issue.assigneeId] : null;
  const overdue = isTaskOverdue(task, today);
  const completed = task.stateType === "completed" ? slashDate(task.completedOn) : null;
  return (
    <Link to={p(`/issue/${task.identifier}`)} className="wbs-row" data-testid="wbs-row" data-identifier={task.identifier}>
      <span className={cx("wbs-process", !task.process && "muted")}>{task.process || "—"}</span>
      <span className="wbs-work">
        <span className="wbs-id">{task.identifier}</span>
        <span className="wbs-title">{task.title}</span>
      </span>
      <span className={cx("wbs-assignee", !user && "muted")}>
        {user ? (
          <>
            <Avatar user={user} size={18} />
            <span className="truncate">{user.name}</span>
          </>
        ) : (
          "未割り当て"
        )}
      </span>
      <span className={cx(!task.startedOn && "muted")}>{task.startedOn ? slashDate(task.startedOn) : "—"}</span>
      <span className={cx("wbs-due", !task.dueDate && "muted", overdue && "is-overdue text-danger")} data-overdue={overdue ? "true" : "false"}>
        {task.dueDate ? slashDate(task.dueDate) : "—"}
      </span>
      <span className="wbs-state">
        {issue ? <StateIcon stateId={issue.stateId} /> : null}
        <span className="truncate">{task.stateName}</span>
      </span>
      <span className={cx(!completed && "muted")}>{completed ?? "—"}</span>
      <span className="wbs-priority">
        <PriorityIcon priority={task.priority} />
        <span>{task.priorityLabel}</span>
      </span>
    </Link>
  );
}

function FilterMenu({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        type="button"
        className="chip-btn"
        data-testid={testId}
        data-popover-anchor
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        {label}：{value}
        <ChevronDown size={13} />
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          onClose={() => setAnchor(null)}
          items={options.map((option) => ({
            label: option.label,
            onSelect: () => onChange(option.id),
          }))}
        />
      )}
    </>
  );
}

function collapsedKey(wsKey: string): string {
  return `sen:wbs-collapsed:${wsKey}`;
}

function readCollapsed(wsKey: string): Set<string> {
  const value = readLocal<unknown>(collapsedKey(wsKey), []);
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id): id is string => typeof id === "string"));
}

function useCollapsed(wsKey: string): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(wsKey));
  useEffect(() => {
    setCollapsed(readCollapsed(wsKey));
  }, [wsKey]);
  return [collapsed, setCollapsed];
}
