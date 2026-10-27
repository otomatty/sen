import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
import type { ProjectStatus } from "../../../shared/types";
import { PALETTE, PROJECT_STATUSES } from "../../../shared/constants";
import { useData } from "../../store/data";
import { archiveProject, updateProject, updateSettings } from "../../store/actions";
import { projectProgress, useActiveIssues, useMembers, useTeams } from "../../store/selectors";
import { openCreateIssue, toast } from "../../store/ui";
import { cx, formatDate, localYmd } from "../../lib/utils";
import { AutoTextarea, Avatar, Button, EmptyState, Menu, Tooltip } from "../../components/ui";
import { ProjectIcon, TeamIcon } from "../../components/icons";
import { PageHeader } from "../../components/PageHeader";
import { DatePicker } from "../../components/DatePicker";
import { Editor } from "../../components/Editor";
import { BurnupChart, ChartLegend } from "../../components/BurnupChart";
import { Picker } from "../../components/Picker";
import { confirmDialog } from "../../components/ConfirmDialog";
import { useDocumentTitle, useWsPath } from "../../app/hooks";
import { IssuesView } from "../issues/IssuesView";
import { ProjectTabs, StatusChip } from "./ProjectsPage";
import type { Me } from "../../../shared/types";

export function ProjectPage() {
  const { projectId, tab } = useParams();
  const project = useData((s) => (projectId ? s.projects[projectId] : undefined));
  const issues = useActiveIssues();
  const states = useData((s) => s.states);
  const users = useData((s) => s.users);
  const me = useData((s) => (s.meId ? (s.users[s.meId] as Me) : null));
  const teams = useTeams();
  const members = useMembers();
  const navigate = useNavigate();
  const p = useWsPath();
  const [name, setName] = useState(project?.name ?? "");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [picker, setPicker] = useState<{ kind: "status" | "lead" | "target" | "start" | "color"; anchor: DOMRect } | null>(null);
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setName(project?.name ?? ""), [project?.name]);
  useDocumentTitle(project?.name ?? "プロジェクト");
  const scoped = useMemo(() => issues.filter((i) => i.projectId === projectId), [issues, projectId]);

  if (!project || project.archivedAt) {
    return (
      <div className="page">
        <PageHeader title="プロジェクト" />
        <EmptyState title="プロジェクトが見つかりません" action={<Button onClick={() => navigate(p("/projects"))}>プロジェクト一覧へ</Button>} />
      </div>
    );
  }
  const favorites = me?.settings?.favorites ?? [];
  const isFav = favorites.some((f) => f.type === "project" && f.id === project.id);
  const toggleFav = () => {
    updateSettings({ favorites: isFav ? favorites.filter((f) => !(f.type === "project" && f.id === project.id)) : [...favorites, { type: "project", id: project.id }] });
    toast(isFav ? "お気に入りから外しました" : "お気に入りに追加しました");
  };
  const title = (
    <span className="page-title-text">
      <Link to={p("/projects")} className="crumb">
        プロジェクト
      </Link>
      <span className="crumb-sep">›</span>
      <ProjectIcon color={project.color} status={project.status} />
      <span className="truncate">{project.name}</span>
    </span>
  );
  const headerActions = (
    <>
      <Tooltip label={isFav ? "お気に入りから外す" : "お気に入りに追加"}>
        <button className={cx("icon-btn", isFav && "fav-on")} onClick={toggleFav} aria-label="お気に入り" data-testid="project-favorite">
          <Star size={15} fill={isFav ? "currentColor" : "none"} />
        </button>
      </Tooltip>
      <button className="icon-btn" aria-label="その他" data-popover-anchor onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}>
        <MoreHorizontal size={15} />
      </button>
      {menu && (
        <Menu
          anchor={menu}
          placement="bottom-end"
          onClose={() => setMenu(null)}
          items={[
            {
              label: "プロジェクトを削除",
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: async () => {
                const ok = await confirmDialog({
                  title: `「${project.name}」を削除しますか？`,
                  message: "課題は削除されず、プロジェクトとの紐づけだけが外れます。",
                  confirmLabel: "削除する",
                  danger: true,
                });
                if (!ok) return;
                archiveProject(project.id);
                navigate(p("/projects"));
              },
            },
          ]}
        />
      )}
    </>
  );

  if (tab === "issues") {
    return (
      <IssuesView
        key={`project:${project.id}`}
        viewKey={`project:${project.id}`}
        issues={scoped}
        listLabel={`${project.name} の課題`}
        screen="projects"
        title={title}
        tabs={<ProjectTabs project={project} />}
        headerExtra={headerActions}
        createDefaults={{ projectId: project.id, teamId: project.teamIds[0] }}
        emptyTitle="このプロジェクトにはまだ課題がありません"
      />
    );
  }

  const prog = projectProgress(project.id, issues, states);
  const lead = project.leadId ? users[project.leadId] : null;
  const start = project.startDate ?? localYmd(new Date(project.createdAt));
  const end = project.targetDate ?? localYmd(new Date(Date.now() + 14 * 86400000));
  const byType = { backlog: 0, unstarted: 0, started: 0, completed: 0, canceled: 0 } as Record<string, number>;
  scoped.forEach((i) => byType[states[i.stateId]?.type ?? "backlog"]++);

  return (
    <div className="page project-page" data-testid="project-page">
      <PageHeader title={title} screen="projects" actions={headerActions}>
        <ProjectTabs project={project} />
      </PageHeader>
      <div className="page-body scroll">
        <div className="project-overview">
          <div className="project-main">
            <div className="project-heading">
              <button className="project-icon-big" data-popover-anchor onClick={(e) => setPicker({ kind: "color", anchor: e.currentTarget.getBoundingClientRect() })} aria-label="色を変更">
                <ProjectIcon color={project.color} status={project.status} size={28} />
              </button>
              <AutoTextarea
                className="detail-title"
                value={name}
                data-testid="project-title"
                onChange={(e) => setName(e.target.value.replace(/\n/g, ""))}
                onKeyDown={(e) => !e.nativeEvent.isComposing && e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
                onBlur={() => (name.trim() && name.trim() !== project.name ? updateProject(project.id, { name: name.trim() }) : setName(project.name))}
              />
            </div>
            <div className="project-props">
              <button className="prop-chip" data-popover-anchor onClick={(e) => setPicker({ kind: "status", anchor: e.currentTarget.getBoundingClientRect() })} data-testid="project-status">
                <StatusChip status={project.status} />
              </button>
              <button className="prop-chip" data-popover-anchor onClick={(e) => setPicker({ kind: "lead", anchor: e.currentTarget.getBoundingClientRect() })}>
                <Avatar user={lead} size={16} />
                {lead ? lead.name : "リード"}
              </button>
              <button className="prop-chip" data-popover-anchor onClick={(e) => setPicker({ kind: "start", anchor: e.currentTarget.getBoundingClientRect() })}>
                開始 {project.startDate ? formatDate(project.startDate) : "未設定"}
              </button>
              <button className="prop-chip" data-popover-anchor onClick={(e) => setPicker({ kind: "target", anchor: e.currentTarget.getBoundingClientRect() })}>
                目標 {project.targetDate ? formatDate(project.targetDate) : "未設定"}
              </button>
              {project.teamIds.map((tid) => {
                const t = teams.find((x) => x.id === tid);
                return t ? (
                  <span key={tid} className="prop-chip static">
                    <TeamIcon team={t} size={14} /> {t.name}
                  </span>
                ) : null;
              })}
            </div>
            <Editor
              key={project.id}
              value={project.description}
              placeholder="プロジェクトの概要・目的・成功の基準を書く…"
              className="detail-description"
              onChange={(html) => {
                if (descTimer.current) clearTimeout(descTimer.current);
                descTimer.current = setTimeout(() => updateProject(project.id, { description: html }), 700);
              }}
            />
            <section className="progress-card">
              <div className="section-title">
                進捗
                <span className="spacer" />
                <b className="big-percent">{prog.percent}%</b>
              </div>
              <div className="progress-bar">
                <div style={{ width: `${prog.percent}%`, background: project.color }} />
              </div>
              <div className="progress-stats">
                <span>
                  <b>{scoped.length - byType.canceled}</b> スコープ
                </span>
                <span>
                  <b>{byType.started}</b> 進行中
                </span>
                <span>
                  <b>{byType.completed}</b> 完了
                </span>
                <span>
                  <b>{byType.backlog + byType.unstarted}</b> 未着手
                </span>
              </div>
              <BurnupChart issues={scoped} states={states} start={start} end={end < start ? start : end} />
              <ChartLegend />
            </section>
            <div className="project-issues-cta">
              <Button icon={<Plus size={14} />} onClick={() => openCreateIssue({ projectId: project.id, teamId: project.teamIds[0] })}>
                課題を追加
              </Button>
              <Link to={p(`/project/${project.id}/issues`)} className="link-btn">
                課題一覧を見る（{scoped.length}件）→
              </Link>
            </div>
          </div>
        </div>
      </div>
      {picker?.kind === "status" && (
        <Picker
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          placeholder="ステータスを変更…"
          options={PROJECT_STATUSES.map((s) => ({
            id: s.value,
            label: s.label,
            icon: <span className="dot" style={{ background: s.color }} />,
            selected: s.value === project.status,
          }))}
          onSelect={(o) => updateProject(project.id, { status: o.id as ProjectStatus })}
        />
      )}
      {picker?.kind === "lead" && (
        <Picker
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          placeholder="リードを選択…"
          options={[
            { id: "none", label: "リードなし", icon: <Avatar user={null} size={16} />, selected: !project.leadId },
            ...members.map((m) => ({ id: m.id, label: m.name, icon: <Avatar user={m} size={16} />, selected: m.id === project.leadId })),
          ]}
          onSelect={(o) => updateProject(project.id, { leadId: o.id === "none" ? null : o.id })}
        />
      )}
      {picker?.kind === "color" && (
        <Picker
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          placeholder="色を選択…"
          options={PALETTE.map((c) => ({ id: c, label: c, icon: <span className="dot big" style={{ background: c }} />, selected: c === project.color }))}
          onSelect={(o) => updateProject(project.id, { color: o.id })}
        />
      )}
      {(picker?.kind === "target" || picker?.kind === "start") && (
        <DatePicker
          anchor={picker.anchor}
          title={picker.kind === "target" ? "目標日" : "開始日"}
          value={picker.kind === "target" ? project.targetDate : project.startDate}
          onClose={() => setPicker(null)}
          onChange={(v) => updateProject(project.id, picker.kind === "target" ? { targetDate: v } : { startDate: v })}
        />
      )}
    </div>
  );
}
