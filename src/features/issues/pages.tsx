import { useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { CircleDot, Search as SearchIcon } from "lucide-react";
import { useData } from "../../store/data";
import { useActiveIssues, useIssueByIdentifier, useTeamByKey } from "../../store/selectors";
import { defaultStateFor } from "../../store/actions";
import { useUI } from "../../store/ui";
import { cx, fuzzyMatch, identifier, htmlToText } from "../../lib/utils";
import { TeamIcon } from "../../components/icons";
import { EmptyState } from "../../components/ui";
import { PageHeader } from "../../components/PageHeader";
import { useDocumentTitle, useWsPath } from "../../app/hooks";
import { IssuesView } from "./IssuesView";
import { IssueDetail } from "./IssueDetail";
import { IssueList } from "./IssueList";
import { DEFAULT_VIEW } from "../../store/view";
import type { Issue } from "../../../shared/types";

function Tabs({ items }: { items: { to: string; label: string; testId?: string }[] }) {
  return (
    <nav className="tabs">
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => cx("tab", isActive && "active")} data-testid={t.testId}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function TeamIssuesPage() {
  const { teamKey, tab = "all" } = useParams();
  const team = useTeamByKey(teamKey);
  const issues = useActiveIssues();
  const states = useData((s) => s.states);
  const p = useWsPath();

  const scoped = useMemo(() => {
    if (!team) return [];
    return issues.filter((i) => {
      if (i.teamId !== team.id) return false;
      const t = states[i.stateId]?.type;
      if (tab === "active") return t === "unstarted" || t === "started";
      if (tab === "backlog") return t === "backlog";
      return true;
    });
  }, [issues, team, tab, states]);

  const tabLabel = tab === "active" ? "アクティブ" : tab === "backlog" ? "バックログ" : "すべての課題";
  useDocumentTitle(team ? `${team.name} › ${tabLabel}` : null);
  if (!team) return <EmptyState title="チームが見つかりません" />;
  return (
    <IssuesView
      key={`${team.id}:${tab}`}
      viewKey={`team:${team.id}:${tab}`}
      issues={scoped}
      teamId={team.id}
      listLabel={`${team.name} › ${tabLabel}`}
      createDefaults={tab === "backlog" ? { stateId: defaultStateFor(team.id, "backlog")?.id } : undefined}
      title={
        <span className="page-title-text">
          <TeamIcon team={team} size={18} />
          {team.name}
        </span>
      }
      tabs={
        <Tabs
          items={[
            { to: p(`/team/${team.key}/all`), label: "すべての課題", testId: "tab-all" },
            { to: p(`/team/${team.key}/active`), label: "アクティブ", testId: "tab-active" },
            { to: p(`/team/${team.key}/backlog`), label: "バックログ", testId: "tab-backlog" },
          ]}
        />
      }
    />
  );
}

export function MyIssuesPage() {
  const { tab = "assigned" } = useParams();
  const issues = useActiveIssues();
  const meId = useData((s) => s.meId);
  const p = useWsPath();
  const scoped = useMemo(
    () =>
      issues.filter((i) =>
        tab === "created" ? i.creatorId === meId : tab === "subscribed" ? i.subscriberIds.includes(meId ?? "") : i.assigneeId === meId,
      ),
    [issues, tab, meId],
  );
  const label = tab === "created" ? "作成した課題" : tab === "subscribed" ? "購読中" : "担当";
  useDocumentTitle("マイイシュー");
  return (
    <IssuesView
      key={tab}
      viewKey={`my:${tab}`}
      issues={scoped}
      listLabel={`マイイシュー › ${label}`}
      screen="my-issues"
      defaults={{ completed: "week" }}
      createDefaults={tab === "assigned" ? { assigneeId: meId } : undefined}
      emptyTitle={tab === "assigned" ? "あなたに割り当てられた課題はありません" : "課題はありません"}
      title={
        <span className="page-title-text">
          <CircleDot size={16} />
          マイイシュー
        </span>
      }
      tabs={
        <Tabs
          items={[
            { to: p("/my-issues/assigned"), label: "担当", testId: "tab-assigned" },
            { to: p("/my-issues/created"), label: "作成", testId: "tab-created" },
            { to: p("/my-issues/subscribed"), label: "購読中", testId: "tab-subscribed" },
          ]}
        />
      }
    />
  );
}

export function IssuePage() {
  const { identifier: ident } = useParams();
  const issue = useIssueByIdentifier(ident);
  const status = useData((s) => s.status);
  useDocumentTitle(issue ? `${ident} ${issue.title}` : ident);
  if (!issue) {
    if (status !== "ready") return null;
    return (
      <div className="page">
        <PageHeader title={<span className="page-title-text">{ident}</span>} />
        <EmptyState title="課題が見つかりません" description="削除されたか、URL が間違っている可能性があります。" />
      </div>
    );
  }
  return (
    <div className="page issue-page">
      <IssueDetail issueId={issue.id} />
    </div>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const issues = useActiveIssues();
  const teams = useData((s) => s.teams);
  const navigate = useNavigate();
  // 入力が止まったら URL に反映（共有・再読み込みしても同じ結果になるように）
  useEffect(() => {
    const t = setTimeout(() => setParams(q ? { q } : {}, { replace: true }), 250);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => {
    if (!q.trim()) return [] as Issue[];
    return issues
      .filter((i) => fuzzyMatch(`${identifier(i, teams)} ${i.title} ${htmlToText(i.description)}`, q))
      .sort((a, b) => {
        // タイトル一致を優先
        const at = fuzzyMatch(a.title, q) ? 0 : 1;
        const bt = fuzzyMatch(b.title, q) ? 0 : 1;
        return at - bt || b.updatedAt - a.updatedAt;
      })
      .slice(0, 200);
  }, [issues, q, teams]);
  const view = { ...DEFAULT_VIEW, grouping: "none" as const, ordering: "updated" as const };
  useDocumentTitle(q ? `「${q}」の検索` : "検索");
  return (
    <div className="page search-page" data-testid="search-page">
      <PageHeader title={<span className="page-title-text">検索</span>} screen="search" />
      <div className="search-box">
        <SearchIcon size={16} className="muted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="課題のタイトル・説明・ID（ENG-12）で検索…"
          data-testid="search-input"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
              if (results[0]) useUI.setState({ focusedIssueId: results[0].id });
            }
            if (e.key === "Escape") navigate(-1);
          }}
        />
        {q && <span className="muted small">{results.length}件</span>}
      </div>
      <div className="page-body">
        {q.trim() ? (
          <IssueList
            groups={[{ key: "r", label: "結果", kind: "none", value: null, issues: results, defaults: {}, patchFor: null }]}
            view={view}
            listKey="search"
            listLabel={`「${q}」の検索結果`}
            hideGroupHeaders
            empty={<EmptyState title="一致する課題はありません" description="別のキーワードで試してください。" />}
          />
        ) : (
          <EmptyState icon={<SearchIcon size={26} />} title="課題を検索" description="入力するとすぐに結果が表示されます（データは手元にあるので待ち時間はありません）。" />
        )}
      </div>
    </div>
  );
}

export function WorkspaceHome() {
  return <Navigate to="my-issues" replace />;
}
