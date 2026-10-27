import { useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { Box, Plus } from "lucide-react";
import type { Project, ProjectStatus } from "../../../shared/types";
import { PALETTE, PROJECT_STATUSES, projectStatusLabel } from "../../../shared/constants";
import { useData } from "../../store/data";
import { createProject } from "../../store/actions";
import { projectProgress, useActiveIssues, useMembers, useProjects, useTeamByKey, useTeams } from "../../store/selectors";
import { useUI } from "../../store/ui";
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

export function ProjectsPage() {
  const { teamKey, filter = "all" } = useParams();
  const team = useTeamByKey(teamKey);
  const projects = useProjects();
  const issues = useActiveIssues();
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const navigate = useNavigate();
  const p = useWsPath();
  const createOpen = useUI((s) => s.projectCreateOpen);
  const [tab, setTab] = useState<"all" | "active" | "planned" | "done">(filter as "all");
  useDocumentTitle(team ? `${team.name} のプロジェクト` : "プロジェクト");

  const list = useMemo(() => {
    let l = team ? projects.filter((pr) => pr.teamIds.includes(team.id)) : projects;
    if (tab === "active") l = l.filter((pr) => pr.status === "started" || pr.status === "paused");
    if (tab === "planned") l = l.filter((pr) => pr.status === "planned" || pr.status === "backlog");
    if (tab === "done") l = l.filter((pr) => pr.status === "completed" || pr.status === "canceled");
    return l;
  }, [projects, team, tab]);

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
        <nav className="tabs">
          {(
            [
              ["all", "すべて"],
              ["active", "進行中"],
              ["planned", "計画中"],
              ["done", "完了"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={cx("tab", tab === k && "active")} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="page-body scroll">
        {list.length === 0 ? (
          <EmptyState
            icon={<Box size={28} />}
            title="プロジェクトはありません"
            description="複数の課題にまたがる目標は、プロジェクトにまとめると進捗が追いやすくなります。"
            action={
              <Button variant="primary" onClick={() => useUI.setState({ projectCreateOpen: true })}>
                プロジェクトを作成
              </Button>
            }
          />
        ) : (
          <div className="table projects-table" role="table">
            <div className="table-head" role="row">
              <span>名前</span>
              <span>状態</span>
              <span>リード</span>
              <span>目標日</span>
              <span>進捗</span>
            </div>
            {list.map((pr) => {
              const prog = projectProgress(pr.id, issues, states);
              const due = pr.status === "completed" ? null : dueStatus(pr.targetDate);
              return (
                <div key={pr.id} className="table-row" role="row" onClick={() => navigate(p(`/project/${pr.id}`))} data-testid="project-row">
                  <span className="cell-name">
                    <ProjectIcon color={pr.color} status={pr.status} size={16} />
                    <b>{pr.name}</b>
                  </span>
                  <span>
                    <StatusChip status={pr.status} />
                  </span>
                  <span>{pr.leadId ? <Avatar user={users[pr.leadId]} size={20} /> : <span className="muted">—</span>}</span>
                  <span className={cx(due === "overdue" && "text-danger", due === "soon" && "text-warn")}>
                    {pr.targetDate ? formatDate(pr.targetDate) : <span className="muted">—</span>}
                  </span>
                  <span className="cell-progress">
                    <ProgressRing percent={prog.percent} color={pr.color} />
                    <span>{prog.percent}%</span>
                    <span className="muted small">
                      {prog.done}/{prog.total}
                    </span>
                  </span>
                </div>
              );
            })}
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
          状態
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
