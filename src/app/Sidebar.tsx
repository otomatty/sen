import { useState } from "react";
import { NavLink, useNavigate } from "react-router";
import {
  Box,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Inbox,
  Keyboard,
  Layers,
  LogOut,
  Monitor,
  Moon,
  PenSquare,
  PlayCircle,
  Plus,
  Search,
  Settings,
  Star,
  Sun,
  UserPlus,
  Target,
  RefreshCw,
} from "lucide-react";
import { useData } from "../store/data";
import { useProjects, useTeams, useUnreadCount } from "../store/selectors";
import { openCreateIssue, setTheme, useUI } from "../store/ui";
import { cx } from "../lib/utils";
import { Kbd, Menu, Tooltip } from "../components/ui";
import { CycleIcon, ProjectIcon, TeamIcon } from "../components/icons";
import { useCurrentTeamId, useWsPath } from "./hooks";
import { logout } from "./session";
import type { Me } from "../../shared/types";

export function Sidebar() {
  const p = useWsPath();
  const navigate = useNavigate();
  const workspace = useData((s) => s.workspace);
  const workspaces = useData((s) => s.workspaces);
  const me = useData((s) => (s.meId ? (s.users[s.meId] as Me) : null));
  const teams = useTeams();
  const projects = useProjects();
  const unread = useUnreadCount();
  const syncStatus = useData((s) => s.syncStatus);
  const pendingCount = useData((s) => s.pendingCount);
  const realtime = useData((s) => s.realtime);
  const theme = useUI((s) => s.theme);
  const currentTeamId = useCurrentTeamId();
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const favorites = (me?.settings?.favorites ?? []).filter((f) => f.type === "project" && projects.some((p) => p.id === f.id));
  const close = () => useUI.setState({ sidebarOpen: false });

  const link = (to: string, icon: React.ReactNode, label: string, extra?: React.ReactNode, testId?: string) => (
    <NavLink to={to} className={({ isActive }) => cx("nav-item", isActive && "active")} onClick={close} data-testid={testId}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {extra}
    </NavLink>
  );

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-top">
        <button
          className="ws-switcher"
          data-popover-anchor
          data-testid="workspace-menu"
          onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
        >
          <span className="ws-avatar">{workspace?.name.slice(0, 1)}</span>
          <span className="ws-name">{workspace?.name}</span>
          <ChevronDown size={13} className="muted" />
        </button>
        <div className="sidebar-actions">
          <Tooltip label="検索" combo="/">
            <button className="icon-btn" onClick={() => navigate(p("/search"))} aria-label="検索" data-testid="sidebar-search">
              <Search size={15} />
            </button>
          </Tooltip>
          <Tooltip label="新しい課題" combo="c">
            <button
              className="icon-btn compose-btn"
              onClick={() => openCreateIssue({ teamId: currentTeamId })}
              aria-label="新しい課題"
              data-testid="sidebar-create"
            >
              <PenSquare size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      <nav className="sidebar-nav">
        {link(p("/inbox"), <Inbox size={15} />, "受信トレイ", unread ? <span className="nav-badge">{unread}</span> : null, "nav-inbox")}
        {link(p("/my-issues"), <CircleDot size={15} />, "マイイシュー", null, "nav-my-issues")}

        <div className="nav-section">ワークスペース</div>
        {link(p("/projects"), <Box size={15} />, "プロジェクト", null, "nav-projects")}

        {favorites.length > 0 && (
          <>
            <div className="nav-section">お気に入り</div>
            {favorites.map((f) => {
              const pr = projects.find((x) => x.id === f.id)!;
              return (
                <NavLink key={f.id} to={p(`/project/${pr.id}`)} className={({ isActive }) => cx("nav-item", isActive && "active")} onClick={close}>
                  <span className="nav-icon">
                    <ProjectIcon color={pr.color} status={pr.status} />
                  </span>
                  <span className="nav-label">{pr.name}</span>
                  <Star size={11} className="muted fav-star" />
                </NavLink>
              );
            })}
          </>
        )}

        <div className="nav-section">チーム</div>
        {teams.map((t) => {
          const isCollapsed = collapsed[t.id];
          return (
            <div key={t.id} className="nav-team">
              <button
                className="nav-item nav-team-head"
                onClick={() => setCollapsed((c) => ({ ...c, [t.id]: !c[t.id] }))}
                data-testid={`nav-team-${t.key}`}
              >
                <span className="nav-icon">
                  <TeamIcon team={t} size={16} />
                </span>
                <span className="nav-label">{t.name}</span>
                {isCollapsed ? <ChevronRight size={13} className="muted" /> : <ChevronDown size={13} className="muted" />}
              </button>
              {!isCollapsed && (
                <div className="nav-team-children">
                  {link(p(`/team/${t.key}/all`), <Layers size={14} />, "課題", null, `nav-team-${t.key}-issues`)}
                  {t.cyclesEnabled && link(p(`/team/${t.key}/cycles`), <CycleIcon size={14} progress={0.5} />, "サイクル", null, `nav-team-${t.key}-cycles`)}
                  {link(p(`/team/${t.key}/projects`), <Target size={14} />, "プロジェクト", null, `nav-team-${t.key}-projects`)}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        {link(p("/help"), <PlayCircle size={15} />, "使い方動画", null, "nav-help")}
        <button className="nav-item" onClick={() => useUI.setState({ shortcutsOpen: true })} data-testid="nav-shortcuts">
          <span className="nav-icon">
            <Keyboard size={15} />
          </span>
          <span className="nav-label">ショートカット</span>
          <Kbd combo="?" />
        </button>
        <div className={cx("sync-status", syncStatus)} data-testid="sync-status" title={realtime ? "リアルタイム同期中" : "定期同期"}>
          <span className="sync-dot" />
          {syncStatus === "offline"
            ? `オフライン（${pendingCount}件の変更を保持中）`
            : syncStatus === "syncing"
              ? "同期中…"
              : realtime
                ? "同期済み・リアルタイム"
                : "同期済み"}
        </div>
      </div>

      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            { label: "設定", icon: <Settings size={14} />, combo: "g s", onSelect: () => navigate(p("/settings/workspace")) },
            { label: "メンバーを招待", icon: <UserPlus size={14} />, onSelect: () => navigate(p("/settings/members")) },
            "divider",
            ...workspaces
              .filter((w) => w.id !== workspace?.id)
              .map((w) => ({ label: `${w.name} に切り替え`, icon: <RefreshCw size={14} />, onSelect: () => navigate(`/${w.urlKey}/my-issues`) })),
            { label: "新しいワークスペースを作成", icon: <Plus size={14} />, onSelect: () => navigate("/new-workspace") },
            "divider",
            {
              label: theme === "dark" ? "テーマ：ダーク" : theme === "light" ? "テーマ：ライト" : "テーマ：システム",
              icon: theme === "dark" ? <Moon size={14} /> : theme === "light" ? <Sun size={14} /> : <Monitor size={14} />,
              onSelect: () => setTheme(theme === "system" ? "dark" : theme === "dark" ? "light" : "system"),
            },
            { label: `ログアウト（${me?.name ?? ""}）`, icon: <LogOut size={14} />, onSelect: () => logout() },
          ]}
        />
      )}
    </aside>
  );
}
