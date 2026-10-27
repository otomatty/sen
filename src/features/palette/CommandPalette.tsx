import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  ArrowRightLeft,
  BarChart3,
  Box,
  CalendarDays,
  CircleDashed,
  CircleDot,
  Columns3,
  Copy,
  CornerLeftUp,
  Hash,
  Inbox,
  Keyboard,
  Layers,
  Link2,
  LogOut,
  Monitor,
  Moon,
  PenSquare,
  PlayCircle,
  Plus,
  Search,
  Settings,
  Sun,
  Tag,
  Trash2,
  Undo2,
  User,
  UserCheck,
  Bell,
  GitBranch,
} from "lucide-react";
import { useData } from "../../store/data";
import { useTeams } from "../../store/selectors";
import { archiveIssues, branchName, createCycle, restoreIssues, toggleSubscription, undo, updateIssues } from "../../store/actions";
import { openCreateIssue, openPicker, setTheme, targetIssueIds, toast, useUI } from "../../store/ui";
import { appUrl, copyText, cx, fuzzyMatch, identifier, normalizeSearch } from "../../lib/utils";
import { SCOPE, useHotkeys } from "../../lib/hotkeys";
import { Kbd, Modal } from "../../components/ui";
import { CycleIcon, TeamIcon } from "../../components/icons";
import { StateIcon } from "../../components/pickers";
import { useWsKey } from "../../app/hooks";
import { logout } from "../../app/session";

interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  combo?: string;
  keywords?: string;
  perform: () => void;
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const navigate = useNavigate();
  const ws = useWsKey();
  const teams = useTeams();
  const issues = useData((s) => s.issues);
  const teamsMap = useData((s) => s.teams);
  const meId = useData((s) => s.meId);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const targets = useMemo(() => targetIssueIds().filter((id) => issues[id]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => useUI.setState({ paletteOpen: false });
  const go = (path: string) => navigate(`/${ws}${path}`);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (targets.length) {
      const first = issues[targets[0]];
      const g = targets.length === 1 ? `課題 ${identifier(first, teamsMap)}` : `${targets.length}件の課題`;
      const pick = (kind: Parameters<typeof openPicker>[0]["kind"]) => () => openPicker({ kind, issueIds: targets, anchor: null });
      list.push(
        { id: "status", label: "ステータスを変更…", group: g, icon: <CircleDashed size={15} />, combo: "s", keywords: "status", perform: pick("status") },
        { id: "priority", label: "優先度を設定…", group: g, icon: <BarChart3 size={15} />, combo: "p", keywords: "priority", perform: pick("priority") },
        { id: "assignee", label: "担当者を変更…", group: g, icon: <User size={15} />, combo: "a", keywords: "assign", perform: pick("assignee") },
        {
          id: "assign-me",
          label: "自分に割り当てる",
          group: g,
          icon: <UserCheck size={15} />,
          combo: "i",
          perform: () => meId && updateIssues(targets, { assigneeId: meId }),
        },
        { id: "labels", label: "ラベルを変更…", group: g, icon: <Tag size={15} />, combo: "l", keywords: "label", perform: pick("labels") },
        { id: "project", label: "プロジェクトに追加…", group: g, icon: <Box size={15} />, combo: "shift+p", keywords: "project", perform: pick("project") },
        { id: "cycle", label: "サイクルに追加…", group: g, icon: <CycleIcon size={15} progress={0.5} />, combo: "shift+c", keywords: "cycle sprint", perform: pick("cycle") },
        { id: "due", label: "期日を設定…", group: g, icon: <CalendarDays size={15} />, combo: "shift+d", keywords: "due date", perform: pick("dueDate") },
        { id: "estimate", label: "見積もりを設定…", group: g, icon: <Hash size={15} />, combo: "shift+e", keywords: "estimate point", perform: pick("estimate") },
        { id: "parent", label: "親課題を設定…", group: g, icon: <CornerLeftUp size={15} />, keywords: "parent", perform: pick("parent") },
        { id: "team", label: "別のチームに移動…", group: g, icon: <ArrowRightLeft size={15} />, keywords: "move team", perform: pick("team") },
      );
      if (targets.length === 1) {
        list.push(
          {
            id: "copy-id",
            label: "ID をコピー",
            group: g,
            icon: <Copy size={15} />,
            combo: "mod+.",
            perform: () => copyText(identifier(first, teamsMap)).then(() => toast("ID をコピーしました")),
          },
          {
            id: "copy-link",
            label: "リンクをコピー",
            group: g,
            icon: <Link2 size={15} />,
            perform: () => copyText(appUrl(`/${ws}/issue/${identifier(first, teamsMap)}`)).then(() => toast("リンクをコピーしました")),
          },
          {
            id: "copy-branch",
            label: "Git ブランチ名をコピー",
            group: g,
            icon: <GitBranch size={15} />,
            combo: "mod+shift+.",
            keywords: "git branch",
            perform: () => copyText(branchName(first.id)).then(() => toast(`${branchName(first.id)} をコピーしました`)),
          },
          { id: "subscribe", label: "通知の購読を切り替え", group: g, icon: <Bell size={15} />, perform: () => toggleSubscription(first.id) },
        );
      }
      list.push({
        id: "delete",
        label: "削除",
        group: g,
        icon: <Trash2 size={15} />,
        combo: "mod+backspace",
        keywords: "delete archive",
        perform: () => {
          archiveIssues(targets);
          toast("課題を削除しました", { action: { label: "元に戻す", run: () => restoreIssues(targets) } });
        },
      });
    }
    list.push(
      { id: "new-issue", label: "新しい課題を作成", group: "作成", icon: <PenSquare size={15} />, combo: "c", keywords: "create new issue", perform: () => openCreateIssue() },
      {
        id: "new-project",
        label: "新しいプロジェクトを作成",
        group: "作成",
        icon: <Plus size={15} />,
        keywords: "create project",
        perform: () => {
          go("/projects");
          useUI.setState({ projectCreateOpen: true });
        },
      },
      ...teams.map((t) => ({
        id: `new-cycle-${t.id}`,
        label: `${t.name} に新しいサイクルを作成`,
        group: "作成",
        icon: <CycleIcon size={15} progress={0} />,
        keywords: "create cycle sprint",
        perform: () => {
          createCycle(t.id);
          go(`/team/${t.key}/cycles`);
          toast("サイクルを作成しました");
        },
      })),
      { id: "go-inbox", label: "受信トレイへ移動", group: "移動", icon: <Inbox size={15} />, combo: "g i", keywords: "inbox", perform: () => go("/inbox") },
      { id: "go-my", label: "マイイシューへ移動", group: "移動", icon: <CircleDot size={15} />, combo: "g m", keywords: "my issues", perform: () => go("/my-issues") },
      { id: "go-projects", label: "プロジェクトへ移動", group: "移動", icon: <Box size={15} />, combo: "g p", keywords: "projects", perform: () => go("/projects") },
      ...teams.flatMap((t) => [
        {
          id: `go-team-${t.id}`,
          label: `${t.name} の課題へ移動`,
          group: "移動",
          icon: <TeamIcon team={t} size={15} />,
          keywords: `${t.key} issues team`,
          perform: () => go(`/team/${t.key}/all`),
        },
        {
          id: `go-backlog-${t.id}`,
          label: `${t.name} のバックログへ移動`,
          group: "移動",
          icon: <Layers size={15} />,
          keywords: `${t.key} backlog`,
          perform: () => go(`/team/${t.key}/backlog`),
        },
        {
          id: `go-cycles-${t.id}`,
          label: `${t.name} のサイクルへ移動`,
          group: "移動",
          icon: <CycleIcon size={15} progress={0.5} />,
          keywords: `${t.key} cycles`,
          perform: () => go(`/team/${t.key}/cycles`),
        },
      ]),
      { id: "go-search", label: "検索", group: "移動", icon: <Search size={15} />, combo: "/", keywords: "search find", perform: () => go("/search") },
      { id: "go-settings", label: "設定を開く", group: "移動", icon: <Settings size={15} />, combo: "g s", keywords: "settings", perform: () => go("/settings/workspace") },
      { id: "go-help", label: "使い方動画を見る", group: "ヘルプ", icon: <PlayCircle size={15} />, combo: "g h", keywords: "help tutorial video", perform: () => go("/help") },
      { id: "shortcuts", label: "キーボードショートカット一覧", group: "ヘルプ", icon: <Keyboard size={15} />, combo: "?", keywords: "keyboard shortcuts", perform: () => useUI.setState({ shortcutsOpen: true }) },
      {
        id: "toggle-layout",
        label: "リスト / ボード表示を切り替え",
        group: "表示",
        icon: <Columns3 size={15} />,
        combo: "mod+b",
        keywords: "board list kanban layout",
        perform: () => window.dispatchEvent(new CustomEvent("sen:toggle-layout")),
      },
      { id: "theme-dark", label: "テーマ：ダーク", group: "表示", icon: <Moon size={15} />, keywords: "theme dark", perform: () => setTheme("dark") },
      { id: "theme-light", label: "テーマ：ライト", group: "表示", icon: <Sun size={15} />, keywords: "theme light", perform: () => setTheme("light") },
      { id: "theme-system", label: "テーマ：システムに合わせる", group: "表示", icon: <Monitor size={15} />, keywords: "theme system", perform: () => setTheme("system") },
      { id: "undo", label: "元に戻す", group: "その他", icon: <Undo2 size={15} />, combo: "mod+z", keywords: "undo", perform: () => undo() },
      { id: "logout", label: "ログアウト", group: "その他", icon: <LogOut size={15} />, keywords: "logout sign out", perform: () => logout() },
    );
    return list;
  }, [targets, issues, teamsMap, teams, meId, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const cmds = commands.filter((c) => fuzzyMatch(`${c.label} ${c.keywords ?? ""} ${c.group}`, q));
    if (!q.trim()) return cmds;
    // 入力があるときは、一致の良さで並べ替える（先頭一致・語の頭での一致を優先）
    const nq = normalizeSearch(q.trim());
    const score = (c: Command) => {
      const label = normalizeSearch(c.label);
      const kw = normalizeSearch(c.keywords ?? "");
      let s = 0;
      if (label.startsWith(nq)) s += 6;
      const idx = label.indexOf(nq);
      if (idx > 0 && /[\s/・（(]/.test(label[idx - 1])) s += 4;
      if (idx >= 0) s += 2;
      if (kw.split(/\s+/).some((k) => k.startsWith(nq))) s += 3;
      return s;
    };
    cmds.sort((a, b) => score(b) - score(a));
    const issueHits: Command[] = Object.values(issues)
      .filter((i) => !i.archivedAt && fuzzyMatch(`${identifier(i, teamsMap)} ${i.title}`, q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((i) => ({
        id: `issue-${i.id}`,
        label: i.title,
        group: "課題",
        icon: <StateIcon stateId={i.stateId} />,
        keywords: identifier(i, teamsMap),
        perform: () => go(`/issue/${identifier(i, teamsMap)}`),
      }));
    return [...cmds, ...issueHits];
  }, [commands, q, issues, teamsMap]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    // ピッカーなど次の画面を開く処理は、パレットが閉じてから
    setTimeout(() => c.perform(), 0);
  };

  useHotkeys("mod+k", () => close(), { allowInInput: true, scope: SCOPE.overlay });

  let last = "";
  return (
    <Modal onClose={close} width={640} className="palette" testId="command-palette">
      {targets.length > 0 && (
        <div className="palette-context">
          {targets.slice(0, 3).map((id) => (
            <span key={id} className="chip">
              {identifier(issues[id], teamsMap)}
            </span>
          ))}
          {targets.length > 3 && <span className="chip">+{targets.length - 3}</span>}
        </div>
      )}
      <input
        className="palette-input"
        autoFocus
        placeholder="コマンドを入力するか、課題を検索…"
        value={q}
        data-testid="palette-input"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(results[active]);
          }
        }}
      />
      <div className="palette-list" ref={listRef}>
        {results.map((c, i) => {
          const header = !q.trim() && c.group !== last ? c.group : null;
          last = c.group;
          return (
            <div key={c.id}>
              {header && <div className="palette-group">{header}</div>}
              <button
                data-index={i}
                className={cx("palette-item", i === active && "active")}
                onMouseMove={() => setActive(i)}
                onClick={() => run(c)}
                data-testid="palette-item"
              >
                <span className="palette-icon">{c.icon}</span>
                <span className="palette-label">{c.label}</span>
                {c.group === "課題" && c.keywords && <span className="muted small">{c.keywords}</span>}
                {q.trim() && c.group !== "課題" && <span className="palette-hint">{c.group}</span>}
                {c.combo && <Kbd combo={c.combo} />}
              </button>
            </div>
          );
        })}
        {!results.length && <div className="picker-empty">一致するコマンドはありません</div>}
      </div>
    </Modal>
  );
}
