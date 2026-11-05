import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { addDays, diffDays, mondayOf } from "../../../shared/dates";
import type { ProgressActivity, ProgressTask } from "../../../shared/progress";
import { cx, readLocal, writeLocal } from "../../lib/utils";
import { useWsPath } from "../../app/hooks";
import { useData } from "../../store/data";
import { Switch } from "../../components/ui";
import { ProjectIcon } from "../../components/icons";
import type { ProgressModel } from "./useProgress";
import { isTaskOverdue, slashDate } from "./parts";

type Zoom = "week" | "month" | "quarter";
type Mark = "done" | "scheduled" | "open" | "milestone" | "undated";

const ZOOMS: { id: Zoom; label: string; px: number }[] = [
  { id: "week", label: "週", px: 28 },
  { id: "month", label: "月", px: 10 },
  { id: "quarter", label: "四半期", px: 4 },
];

const ZOOM_KEY = "sen:timeline-zoom";

/** 作業の日付と「今日の14日前〜28日後」を含む。始まりは月曜、終わりは日曜 */
function timelineRange(dates: string[], today: string): { start: string; end: string } {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const date of dates) {
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;
  }
  const earliestEdge = addDays(today, -14);
  const latestEdge = addDays(today, 28);
  const startRaw = earliest && earliest < earliestEdge ? earliest : earliestEdge;
  const endRaw = latest && latest > latestEdge ? latest : latestEdge;
  return { start: mondayOf(startRaw), end: addDays(mondayOf(endRaw), 6) };
}

function monthSpans(start: string, end: string): { label: string; days: number }[] {
  const spans: { label: string; days: number }[] = [];
  let cursor = start;
  let prevYear: number | null = null;
  while (cursor <= end) {
    const [yearText, monthText] = cursor.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const prefix = `${yearText}-${monthText}`;
    let days = 0;
    while (cursor <= end && cursor.startsWith(prefix)) {
      days += 1;
      cursor = addDays(cursor, 1);
    }
    const label = prevYear == null || prevYear !== year ? `${year}年${month}月` : `${month}月`;
    spans.push({ label, days });
    prevYear = year;
  }
  return spans;
}

function weekMondays(start: string, end: string): string[] {
  const weeks: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 7)) weeks.push(day);
  return weeks;
}

function monthDay(ymd: string): string {
  const [, month, day] = ymd.split("-");
  return `${month}/${day}`;
}

function yearLabel(start: string, end: string): string {
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  return startYear === endYear ? `${startYear}年` : `${startYear}–${endYear}年`;
}

function shownTasks(tasks: ProgressTask[], showDone: boolean): ProgressTask[] {
  return showDone ? tasks : tasks.filter((task) => task.stateType !== "completed");
}

function markOf(task: ProgressTask): Mark {
  if (task.startedOn && task.stateType === "completed") return "done";
  if (task.startedOn && task.dueDate) return "scheduled";
  if (task.startedOn) return "open";
  if (task.dueDate) return "milestone";
  return "undated";
}

/** from が to より後でも入れ替えない。逆向きの区間は from の 1 日分にする */
function spanBox(from: string, to: string, rangeStart: string, dayWidth: number): { left: number; width: number } {
  const end = to >= from ? to : from;
  return {
    left: diffDays(rangeStart, from) * dayWidth,
    width: (diffDays(from, end) + 1) * dayWidth,
  };
}

function dueBeforeStart(task: ProgressTask): boolean {
  return !!(task.startedOn && task.dueDate && task.dueDate < task.startedOn);
}

function doneSpan(task: ProgressTask): string {
  if (task.completedOn && task.startedOn && task.completedOn < task.startedOn) {
    return `着手 ${slashDate(task.startedOn)}（完了日 ${slashDate(task.completedOn)} は着手より前）`;
  }
  return `着手 ${slashDate(task.startedOn)} → 完了日 ${slashDate(task.completedOn)}`;
}

function captionOf(task: ProgressTask, mark: Mark): string {
  const head = `${task.identifier} ${task.title}`;
  if (dueBeforeStart(task)) {
    const work = mark === "done" ? doneSpan(task) : `着手 ${slashDate(task.startedOn)} → 今日`;
    return `${head} / 完了予定 ${slashDate(task.dueDate)}（着手より前） / ${work}`;
  }
  if (mark === "done") return `${head} / ${doneSpan(task)}`;
  if (mark === "scheduled") return `${head} / 着手 ${slashDate(task.startedOn)} → 完了予定 ${slashDate(task.dueDate)}`;
  if (mark === "open") return `${head} / 着手 ${slashDate(task.startedOn)} → 予定なし`;
  return `${head} / 完了予定 ${slashDate(task.dueDate)}`;
}

function readZoom(): Zoom {
  const value = readLocal<unknown>(ZOOM_KEY, "month");
  return value === "week" || value === "month" || value === "quarter" ? value : "month";
}

function sampleColor(states: ProgressModel["states"], type: string): string {
  const found = Object.values(states)
    .filter((state) => state.type === type)
    .sort((a, b) => a.position - b.position);
  return found[0]?.color ?? "var(--accent)";
}

export function TimelineTab({ model }: { model: ProgressModel }) {
  const { activities, today, states } = model;
  const wsKey = useData((s) => s.workspace?.urlKey ?? "");
  const [zoom, setZoom] = useState<Zoom>(readZoom);
  const [showDone, setShowDone] = useState(true);
  const [collapsed, setCollapsed] = useCollapsed(wsKey);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayWidth = ZOOMS.find((item) => item.id === zoom)?.px ?? 10;

  const range = useMemo(() => {
    const dates: string[] = [];
    for (const activity of activities) {
      for (const task of shownTasks(activity.tasks, showDone)) {
        if (task.startedOn) dates.push(task.startedOn);
        if (task.dueDate) dates.push(task.dueDate);
        if (task.completedOn) dates.push(task.completedOn);
      }
    }
    return timelineRange(dates, today);
  }, [activities, showDone, today]);

  const dayCount = diffDays(range.start, range.end) + 1;
  const chartWidth = dayCount * dayWidth;
  const todayX = diffDays(range.start, today) * dayWidth + dayWidth / 2;
  const months = useMemo(() => monthSpans(range.start, range.end), [range.start, range.end]);
  const weeks = useMemo(() => weekMondays(range.start, range.end), [range.start, range.end]);
  const activeColor = sampleColor(states, "started");
  const doneColor = sampleColor(states, "completed");
  const milestoneColor = sampleColor(states, "unstarted");

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const sheet = scroller?.querySelector(".timeline-sheet");
    if (!scroller || !sheet) return;
    const label = Number.parseFloat(getComputedStyle(sheet).getPropertyValue("--timeline-label"));
    const labelWidth = Number.isFinite(label) ? label : 0;
    const safe = Math.max(scroller.clientWidth / 3, labelWidth + 16);
    scroller.scrollLeft = Math.max(0, labelWidth + todayX - safe);
  }, [todayX, chartWidth]);

  const chooseZoom = (next: Zoom) => {
    setZoom(next);
    writeLocal(ZOOM_KEY, next);
  };
  const toggle = (projectId: string) => {
    const next = new Set(collapsed);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    setCollapsed(next);
    writeLocal(collapsedKey(wsKey), [...next]);
  };
  const sheetStyle = {
    "--timeline-chart": `${chartWidth}px`,
    "--timeline-week": `${dayWidth * 7}px`,
  } as CSSProperties;

  return (
    <div className="progress-timeline" data-testid="progress-timeline">
      <div className="timeline-toolbar">
        <div className="timeline-zooms" role="group" aria-label="縮尺">
          {ZOOMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cx("chip-btn", zoom === item.id && "on")}
              aria-pressed={zoom === item.id}
              data-testid={`timeline-zoom-${item.id}`}
              onClick={() => chooseZoom(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="wbs-toggle">
          <Switch id="timeline-done-switch" checked={showDone} onChange={setShowDone} label="完了も表示" testId="timeline-toggle-done" />
          <label htmlFor="timeline-done-switch">完了も表示</label>
        </span>
      </div>
      {activities.length > 0 && <TimelineLegend activeColor={activeColor} doneColor={doneColor} milestoneColor={milestoneColor} />}
      {activities.length === 0 ? (
        <p className="progress-empty">プロジェクトはありません</p>
      ) : (
        <div className="timeline-scroll" ref={scrollRef}>
          <div className="timeline-sheet" style={sheetStyle}>
            <div className="timeline-today" data-testid="timeline-today" style={{ left: `calc(var(--timeline-label) + ${todayX}px)` }} />
            <div className="timeline-scale">
              <div className="timeline-label timeline-corner">{yearLabel(range.start, range.end)}</div>
              <div className="timeline-scale-body">
                <div className="timeline-months">
                  {months.map((month, index) => (
                    <div key={`${index}-${month.label}`} className="timeline-month" style={{ width: month.days * dayWidth }} title={month.label}>
                      <span className="timeline-month-label">{month.label}</span>
                    </div>
                  ))}
                </div>
                <div className="timeline-weeks">
                  {weeks.map((monday) => (
                    <div key={monday} className="timeline-week" style={{ width: dayWidth * 7 }} title={slashDate(monday) ?? monday}>
                      <span className="timeline-week-label">{monthDay(monday)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {activities.map((activity) => (
              <TimelineGroup
                key={activity.projectId}
                activity={activity}
                model={model}
                collapsed={collapsed.has(activity.projectId)}
                onToggle={() => toggle(activity.projectId)}
                rows={shownTasks(activity.tasks, showDone)}
                rangeStart={range.start}
                dayWidth={dayWidth}
                today={today}
              />
            ))}
          </div>
        </div>
      )}
      <p className="progress-note">着手日と完了予定がそろっている作業ほど正確に描けます。日付のない作業は件数だけ出し、押すと WBS で一覧します。</p>
    </div>
  );
}

function TimelineLegend({ activeColor, doneColor, milestoneColor }: { activeColor: string; doneColor: string; milestoneColor: string }) {
  return (
    <ul className="timeline-legend">
      <li>
        <span className="timeline-legend-bar" style={{ background: activeColor }} />
        進行中（着手日 → 完了予定）
      </li>
      <li>
        <span className="timeline-legend-bar" style={{ background: doneColor }} />
        完了（着手日 → 完了日）
      </li>
      <li>
        <span className="timeline-legend-bar is-open" style={{ background: activeColor }} />
        予定なし（今日まで）
      </li>
      <li>
        <span className="timeline-legend-diamond" style={{ "--mark": milestoneColor } as CSSProperties}>
          ◆
        </span>
        完了予定だけ
      </li>
      <li>
        <span className="timeline-legend-today" />
        今日
      </li>
    </ul>
  );
}

function TimelineGroup({
  activity,
  model,
  rows,
  collapsed,
  onToggle,
  rangeStart,
  dayWidth,
  today,
}: {
  activity: ProgressActivity;
  model: ProgressModel;
  rows: ProgressTask[];
  collapsed: boolean;
  onToggle: () => void;
  rangeStart: string;
  dayWidth: number;
  today: string;
}) {
  const project = model.projects[activity.projectId];
  const p = useWsPath();
  const color = project?.color ?? "var(--accent)";
  const dated = rows.filter((task) => markOf(task) !== "undated");
  const undated = rows.length - dated.length;
  return (
    <section className="timeline-group" data-testid="timeline-group" data-project-id={activity.projectId}>
      <div className="timeline-group-head">
        <div className="timeline-label">
          <button
            type="button"
            className="icon-btn"
            aria-expanded={!collapsed}
            aria-label={`${activity.name}を${collapsed ? "開く" : "閉じる"}`}
            data-testid="timeline-group-toggle"
            onClick={onToggle}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <span className="wbs-swatch" style={{ background: color }} />
          <Link to={p(`/project/${activity.projectId}`)} className="timeline-project">
            <ProjectIcon color={color} status={project?.status} size={14} />
            <span className="truncate">{activity.name}</span>
          </Link>
          <span className="timeline-rate">{activity.completionRate}</span>
        </div>
      </div>
      {!collapsed &&
        dated.map((task) => (
          <TimelineRow key={task.id} task={task} model={model} rangeStart={rangeStart} dayWidth={dayWidth} today={today} />
        ))}
      {!collapsed && undated > 0 && (
        <Link to={p("/progress/wbs")} className="timeline-undated" data-testid="timeline-undated">
          日付のない作業 {undated} 件
        </Link>
      )}
    </section>
  );
}

function TimelineRow({
  task,
  model,
  rangeStart,
  dayWidth,
  today,
}: {
  task: ProgressTask;
  model: ProgressModel;
  rangeStart: string;
  dayWidth: number;
  today: string;
}) {
  const p = useWsPath();
  const href = p(`/issue/${task.identifier}`);
  const mark = markOf(task);
  const issue = model.issues[task.id];
  const color = (issue && model.states[issue.stateId]?.color) || "var(--accent)";
  const overdue = isTaskOverdue(task, today);
  const text = captionOf(task, mark);
  const earlyDue = dueBeforeStart(task);
  return (
    <div className="timeline-row" data-testid="timeline-row" data-identifier={task.identifier}>
      <Link to={href} className="timeline-label">
        <span className="timeline-id">{task.identifier}</span>
        <span className="timeline-title">{task.title}</span>
      </Link>
      <div className="timeline-track">
        {mark === "milestone" && task.dueDate ? (
          <DueMark href={href} dueDate={task.dueDate} color={color} overdue={overdue} text={text} rangeStart={rangeStart} dayWidth={dayWidth} />
        ) : (
          <>
            <Bar task={task} mark={mark} color={color} overdue={overdue} text={text} href={href} rangeStart={rangeStart} dayWidth={dayWidth} today={today} />
            {earlyDue && task.dueDate && (
              <DueMark href={href} dueDate={task.dueDate} color={color} overdue={overdue} text={text} rangeStart={rangeStart} dayWidth={dayWidth} label={false} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DueMark({
  href,
  dueDate,
  color,
  overdue,
  text,
  rangeStart,
  dayWidth,
  label = true,
}: {
  href: string;
  dueDate: string;
  color: string;
  overdue: boolean;
  text: string;
  rangeStart: string;
  dayWidth: number;
  /** 棒と並べる印は ◆ だけにする。ラベルが棒に重なるため */
  label?: boolean;
}) {
  return (
    <Link
      to={href}
      className={cx("timeline-milestone", overdue && "is-overdue")}
      data-testid="timeline-milestone"
      title={text}
      aria-label={text}
      style={{ left: diffDays(rangeStart, dueDate) * dayWidth + dayWidth / 2, "--mark": color } as CSSProperties}
    >
      <span className="timeline-milestone-mark" aria-hidden>
        ◆
      </span>
      {label && <span className="timeline-milestone-label">完了予定 {monthDay(dueDate)}</span>}
    </Link>
  );
}

function Bar({
  task,
  mark,
  color,
  overdue,
  text,
  href,
  rangeStart,
  dayWidth,
  today,
}: {
  task: ProgressTask;
  mark: Mark;
  color: string;
  overdue: boolean;
  text: string;
  href: string;
  rangeStart: string;
  dayWidth: number;
  today: string;
}) {
  if (!task.startedOn) return null;
  const started = task.startedOn;
  const earlyDue = dueBeforeStart(task);
  let end: string | null = null;
  let open = false;
  if (mark === "done") {
    end = task.completedOn && task.completedOn >= started ? task.completedOn : started;
  } else if (mark === "open" || earlyDue) {
    // 期限が着手より前の未完了は、予定なしと同じく着手日から今日まで
    open = true;
    end = today >= started ? today : started;
  } else {
    end = task.dueDate;
  }
  if (!end) return null;
  const box = spanBox(started, end, rangeStart, dayWidth);
  return (
    <Link
      to={href}
      className={cx("timeline-bar", open && "is-open", overdue && "is-overdue")}
      data-testid="timeline-bar"
      title={text}
      aria-label={text}
      style={{ left: box.left, width: box.width, background: color }}
    />
  );
}

function collapsedKey(wsKey: string): string {
  return `sen:timeline-collapsed:${wsKey}`;
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
