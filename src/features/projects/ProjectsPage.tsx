import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Box, Plus } from "lucide-react";
import type { Project, ProjectStatus, User } from "../../../shared/types";
import { PALETTE, PROJECT_STATUSES, projectStatusLabel } from "../../../shared/constants";
import { useData } from "../../store/data";
import { createProject, updateProject } from "../../store/actions";
import { projectProgress, useActiveIssues, useMembers, useProjects, useTeamByKey, useTeams } from "../../store/selectors";
import { useUI } from "../../store/ui";
import { planProjectMove } from "../../lib/projectOrder";
import { cx, dueStatus, formatDate } from "../../lib/utils";
import { Avatar, Button, EmptyState, Modal } from "../../components/ui";
import { ProgressRing, ProjectIcon, TeamIcon } from "../../components/icons";
import { PageHeader } from "../../components/PageHeader";
import { DatePicker } from "../../components/DatePicker";
import { Editor } from "../../components/Editor";
import { useDocumentTitle, useWsPath } from "../../app/hooks";

export function StatusChip({ status }: { status: ProjectStatus }) {
  const meta = PROJECT_STATUSES.find((s) => s.value === status);
  return (
    <span className="status-chip">
      <span className="dot" style={{ background: meta?.color }} />
      {projectStatusLabel(status)}
    </span>
  );
}

const PROJECT_TABS = [
  { key: "active", label: "進行中", testId: "projects-tab-active", empty: "進行中のプロジェクトはありません" },
  { key: "planned", label: "計画中", testId: "projects-tab-planned", empty: "計画中のプロジェクトはありません" },
  { key: "done", label: "完了", testId: "projects-tab-done", empty: "完了したプロジェクトはありません" },
] as const;

type ProjectTab = (typeof PROJECT_TABS)[number]["key"];

const TAB_STATUSES: Record<ProjectTab, readonly ProjectStatus[]> = {
  active: ["started", "paused"],
  planned: ["planned", "backlog"],
  done: ["completed", "canceled"],
};

/** クエリ `status`。無い、または planned / done 以外は進行中。進行中のときはパラメータを付けない。 */
function tabFromStatus(status: string | null): ProjectTab {
  if (status === "planned" || status === "done") return status;
  return "active";
}

function projectInTab(status: ProjectStatus, tab: ProjectTab) {
  return TAB_STATUSES[tab].includes(status);
}

/** そのステータスのプロジェクトが並ぶ一覧タブのパス（ワークスペース相対）。進行中ならクエリは付けない */
export function projectsListPath(status: ProjectStatus): string {
  const tab = PROJECT_TABS.find((t) => projectInTab(status, t.key))?.key;
  if (!tab || tab === "active") return "/projects";
  return `/projects?status=${tab}`;
}

/** 選択中以外で件数があるタブを「計画中に 2 件、完了に 1 件あります。」の形で案内する */
function ProjectTabHints({
  tab,
  counts,
  onSelect,
}: {
  tab: ProjectTab;
  counts: Record<ProjectTab, number>;
  onSelect: (next: ProjectTab) => void;
}) {
  const others = PROJECT_TABS.filter((t) => t.key !== tab && counts[t.key] > 0);
  return (
    <>
      {others.map((t, i) => (
        <span key={t.key}>
          {i > 0 && "、"}
          <button type="button" className="link-btn" onClick={() => onSelect(t.key)}>
            {t.label}
          </button>
          に {counts[t.key]} 件{i === others.length - 1 && "あります。"}
        </span>
      ))}
    </>
  );
}

/** 一覧の 1 行。少し動かしてからドラッグになり、クリックは詳細へ移る */
function SortableProjectRow({
  project,
  lead,
  progress,
  onOpen,
}: {
  project: Project;
  lead: User | null;
  progress: { percent: number; done: number; total: number };
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    attributes: { role: "row", tabIndex: -1 },
  });
  const due = project.status === "completed" ? null : dueStatus(project.targetDate);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null), transition }}
      className={cx("table-row", isDragging && "dragging")}
      data-testid="project-row"
      {...attributes}
      {...listeners}
      role="row"
      onClick={onOpen}
    >
      <span className="cell-name">
        <ProjectIcon color={project.color} status={project.status} size={16} />
        <b>{project.name}</b>
      </span>
      <span>
        <StatusChip status={project.status} />
      </span>
      <span>{lead ? <Avatar user={lead} size={20} /> : <span className="muted">—</span>}</span>
      <span className={cx(due === "overdue" && "text-danger", due === "soon" && "text-warn")}>
        {project.targetDate ? formatDate(project.targetDate) : <span className="muted">—</span>}
      </span>
      <span className="cell-progress">
        <ProgressRing percent={progress.percent} color={project.color} />
        <span>{progress.percent}%</span>
        <span className="muted small">
          {progress.done}/{progress.total}
        </span>
      </span>
    </div>
  );
}

export function ProjectsPage() {
  const { teamKey } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = tabFromStatus(params.get("status"));
  const team = useTeamByKey(teamKey);
  const projects = useProjects();
  const issues = useActiveIssues();
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const navigate = useNavigate();
  const p = useWsPath();
  const createOpen = useUI((s) => s.projectCreateOpen);
  useDocumentTitle(team ? `${team.name} のプロジェクト` : "プロジェクト");
  // 指はすぐ動かすと一覧をスクロールしたいので、長押ししてからドラッグにする。マウスは少し動かしたらドラッグ。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const selectTab = (next: ProjectTab) => {
    setParams((prev) => {
      const nextParams = new URLSearchParams(prev);
      if (next === "active") nextParams.delete("status");
      else nextParams.set("status", next);
      return nextParams;
    }, { replace: true });
  };

  const scoped = useMemo(
    () => (team ? projects.filter((pr) => pr.teamIds.includes(team.id)) : projects),
    [projects, team],
  );
  const counts = useMemo(
    () => ({
      active: scoped.filter((pr) => projectInTab(pr.status, "active")).length,
      planned: scoped.filter((pr) => projectInTab(pr.status, "planned")).length,
      done: scoped.filter((pr) => projectInTab(pr.status, "done")).length,
    }),
    [scoped],
  );
  const list = useMemo(() => scoped.filter((pr) => projectInTab(pr.status, tab)), [scoped, tab]);
  const noProjects = counts.active + counts.planned + counts.done === 0;
  const tabMeta = PROJECT_TABS.find((t) => t.key === tab) ?? PROJECT_TABS[0];

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = list.findIndex((pr) => pr.id === active.id);
    const newIndex = list.findIndex((pr) => pr.id === over.id);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const moved = arrayMove(list, oldIndex, newIndex);
    const nextRow = moved[newIndex + 1];
    const prevRow = moved[newIndex - 1];
    // 表示中の並びで、すぐ後ろがあればその直前、一番下ならすぐ前の直後に入れる
    const anchor = nextRow ? { beforeId: nextRow.id } : prevRow ? { afterId: prevRow.id } : null;
    if (!anchor) return;
    for (const update of planProjectMove(projects, String(active.id), anchor)) {
      updateProject(update.id, { sortOrder: update.sortOrder });
    }
  };

  return (
    <div className="page projects-page" data-testid="projects-page">
      <PageHeader
        title={
          <span className="page-title-text">
            {team ? <TeamIcon team={team} size={18} /> : <Box size={16} />}
            {team ? `${team.name} のプロジェクト` : "プロジェクト"}
          </span>
        }
        screen="projects"
        actions={
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => useUI.setState({ projectCreateOpen: true })} data-testid="new-project">
            新しいプロジェクト
          </Button>
        }
      >
        <nav className="tabs" role="tablist">
          {PROJECT_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={cx("tab", tab === t.key && "active")}
              data-testid={t.testId}
              onClick={() => selectTab(t.key)}
            >
              {t.label}<span className="tab-count">{counts[t.key]}</span>
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="page-body scroll">
        {list.length === 0 ? (
          <EmptyState
            icon={<Box size={28} />}
            title={noProjects ? "プロジェクトはありません" : tabMeta.empty}
            description={
              noProjects ? (
                "複数の課題にまたがる目標は、プロジェクトにまとめると進捗が追いやすくなります。"
              ) : (
                <ProjectTabHints tab={tab} counts={counts} onSelect={selectTab} />
              )
            }
            action={
              <Button variant="primary" onClick={() => useUI.setState({ projectCreateOpen: true })}>
                プロジェクトを作成
              </Button>
            }
            testId="projects-empty"
          />
        ) : (
          <div className="table projects-table" role="table">
            <div className="table-head" role="row">
              <span>名前</span>
              <span>ステータス</span>
              <span>リード</span>
              <span>目標日</span>
              <span>進捗</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={list.map((pr) => pr.id)} strategy={verticalListSortingStrategy}>
                {list.map((pr) => (
                  <SortableProjectRow
                    key={pr.id}
                    project={pr}
                    lead={pr.leadId ? users[pr.leadId] ?? null : null}
                    progress={projectProgress(pr.id, issues, states)}
                    onOpen={() => navigate(p(`/project/${pr.id}`))}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </div>
      {createOpen && <ProjectCreateModal defaultTeamId={team?.id} />}
    </div>
  );
}

function ProjectCreateModal({ defaultTeamId }: { defaultTeamId?: string }) {
  const teams = useTeams();
  const members = useMembers();
  const meId = useData((s) => s.meId);
  const navigate = useNavigate();
  const p = useWsPath();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>("planned");
  const [leadId, setLeadId] = useState<string | null>(meId);
  const [teamIds, setTeamIds] = useState<string[]>(defaultTeamId ? [defaultTeamId] : teams.slice(0, 1).map((t) => t.id));
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [color, setColor] = useState(PALETTE[Math.floor(Math.random() * 6)]);
  const [dateAnchor, setDateAnchor] = useState<DOMRect | null>(null);
  const close = () => useUI.setState({ projectCreateOpen: false });
  const submit = () => {
    if (!name.trim()) return;
    const id = createProject({ name: name.trim(), description, status, leadId, teamIds, targetDate, color });
    close();
    navigate(p(`/project/${id}`));
  };
  return (
    <Modal onClose={close} width={620} className="create-modal" testId="project-create-modal">
      <div className="create-head">
        <span className="muted">新しいプロジェクト</span>
      </div>
      <div className="create-body">
        <div className="project-name-row">
          <ProjectIcon color={color} size={22} status={status} />
          <input
            autoFocus
            className="create-title"
            placeholder="プロジェクト名"
            value={name}
            data-testid="project-name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => !e.nativeEvent.isComposing && e.key === "Enter" && submit()}
          />
        </div>
        <Editor value={description} onChange={setDescription} placeholder="概要・目的を書く…" className="create-description" onSubmit={submit} />
      </div>
      <div className="form-grid">
        <label>
          ステータス
          <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          リード
          <select value={leadId ?? ""} onChange={(e) => setLeadId(e.target.value || null)}>
            <option value="">なし</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          目標日
          <button type="button" className="input-like" data-popover-anchor onClick={(e) => setDateAnchor(e.currentTarget.getBoundingClientRect())}>
            {targetDate ? formatDate(targetDate, true) : "未設定"}
          </button>
        </label>
        <label>
          色
          <span className="color-row">
            {PALETTE.slice(0, 10).map((c) => (
              <button type="button" key={c} className={cx("color-swatch", c === color && "on")} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
          </span>
        </label>
        <div className="form-wide">
          チーム
          <span className="team-toggle-row">
            {teams.map((t) => (
              <button
                type="button"
                key={t.id}
                className={cx("prop-toggle", teamIds.includes(t.id) && "on")}
                onClick={() => setTeamIds((ids) => (ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id]))}
              >
                <TeamIcon team={t} size={14} /> {t.name}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="create-foot">
        <span className="spacer" />
        <Button variant="ghost" onClick={close}>
          キャンセル
        </Button>
        <Button variant="primary" onClick={submit} disabled={!name.trim()} data-testid="project-create-submit">
          プロジェクトを作成
        </Button>
      </div>
      {dateAnchor && <DatePicker anchor={dateAnchor} value={targetDate} onChange={setTargetDate} onClose={() => setDateAnchor(null)} title="目標日" />}
    </Modal>
  );
}

export function ProjectTabs({ project }: { project: Project }) {
  const p = useWsPath();
  return (
    <nav className="tabs">
      <NavLink end to={p(`/project/${project.id}`)} className={({ isActive }) => cx("tab", isActive && "active")} data-testid="project-tab-overview">
        概要
      </NavLink>
      <NavLink to={p(`/project/${project.id}/issues`)} className={({ isActive }) => cx("tab", isActive && "active")} data-testid="project-tab-issues">
        課題
      </NavLink>
    </nav>
  );
}
