import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  ArrowLeftRight,
  ArrowRightLeft,
  BarChart3,
  ChartColumn,
  Box,
  CalendarDays,
  CircleDashed,
  CircleDot,
  Columns3,
  Copy,
  CornerLeftUp,
  Download,
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
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Tag,
  Trash2,
  Undo2,
  User,
  UserCheck,
  UserPlus,
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
import { addAccount, logout, switchAccount, useSession } from "../../app/session";
import { applyUpdate, installApp, usePWA } from "../../app/pwa";
import { openRelationPicker, RELATION_ACTIONS, RELATION_ICON } from "../issues/Relations";
import type { Issue, Team } from "../../../shared/types";
import { COMMANDS, presentCommand, resolveScreenPath, type CommandDef, type CommandId } from "../../../shared/navigation";
import { openAssistant, useAssistant } from "../../store/assistant";

interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  combo?: string;
  keywords?: string;
  /** テスト用。ask-ai の項目だけ付ける */
  command?: string;
  perform: () => void;
}

interface PaletteCtx {
  navigate: (to: string) => void;
  ws: string;
  targets: string[];
  issues: Record<string, Issue>;
  teams: Record<string, Team>;
  meId: string | null;
  team?: Team;
}

function goTo(screen: Parameters<typeof resolveScreenPath>[0], ctx: PaletteCtx) {
  const path = resolveScreenPath(screen, { ws: ctx.ws, teamKey: ctx.team?.key, teamId: ctx.team?.id });
  if (path) ctx.navigate(path);
}

function pick(kind: Parameters<typeof openPicker>[0]["kind"]): (ctx: PaletteCtx) => void {
  return (ctx) => openPicker({ kind, issueIds: ctx.targets, anchor: null });
}

interface CommandAction {
  icon: (team?: Team) => ReactNode;
  perform: (ctx: PaletteCtx) => void;
}

const COMMAND_RUNTIME = {
  status: { icon: () => <CircleDashed size={15} />, perform: pick("status") },
  priority: { icon: () => <BarChart3 size={15} />, perform: pick("priority") },
  assignee: { icon: () => <User size={15} />, perform: pick("assignee") },
  "assign-me": {
    icon: () => <UserCheck size={15} />,
    perform: (ctx) => ctx.meId && updateIssues(ctx.targets, { assigneeId: ctx.meId }),
  },
  labels: { icon: () => <Tag size={15} />, perform: pick("labels") },
  project: { icon: () => <Box size={15} />, perform: pick("project") },
  cycle: { icon: () => <CycleIcon size={15} progress={0.5} />, perform: pick("cycle") },
  due: { icon: () => <CalendarDays size={15} />, perform: pick("dueDate") },
  estimate: { icon: () => <Hash size={15} />, perform: pick("estimate") },
  parent: { icon: () => <CornerLeftUp size={15} />, perform: pick("parent") },
  team: { icon: () => <ArrowRightLeft size={15} />, perform: pick("team") },
  "copy-id": {
    icon: () => <Copy size={15} />,
    perform: (ctx) => {
      const first = ctx.issues[ctx.targets[0]];
      copyText(identifier(first, ctx.teams)).then(() => toast("ID をコピーしました"));
    },
  },
  "copy-link": {
    icon: () => <Link2 size={15} />,
    perform: (ctx) => {
      const first = ctx.issues[ctx.targets[0]];
      copyText(appUrl(`/${ctx.ws}/issue/${identifier(first, ctx.teams)}`)).then(() => toast("リンクをコピーしました"));
    },
  },
  "copy-branch": {
    icon: () => <GitBranch size={15} />,
    perform: (ctx) => {
      const first = ctx.issues[ctx.targets[0]];
      copyText(branchName(first.id)).then(() => toast(`${branchName(first.id)} をコピーしました`));
    },
  },
  subscribe: { icon: () => <Bell size={15} />, perform: (ctx) => toggleSubscription(ctx.issues[ctx.targets[0]].id) },
  delete: {
    icon: () => <Trash2 size={15} />,
    perform: (ctx) => {
      archiveIssues(ctx.targets);
      toast("課題を削除しました", { action: { label: "元に戻す", run: () => restoreIssues(ctx.targets) } });
    },
  },
  "new-issue": { icon: () => <PenSquare size={15} />, perform: () => openCreateIssue() },
  "new-project": {
    icon: () => <Plus size={15} />,
    perform: (ctx) => {
      goTo("projects", ctx);
      useUI.setState({ projectCreateOpen: true });
    },
  },
  "new-cycle": {
    icon: () => <CycleIcon size={15} progress={0} />,
    perform: (ctx) => {
      if (!ctx.team) return;
      createCycle(ctx.team.id);
      goTo("team-cycles", ctx);
      toast("サイクルを作成しました");
    },
  },
  "go-inbox": { icon: () => <Inbox size={15} />, perform: (ctx) => goTo("inbox", ctx) },
  "go-my": { icon: () => <CircleDot size={15} />, perform: (ctx) => goTo("my-issues", ctx) },
  "go-projects": { icon: () => <Box size={15} />, perform: (ctx) => goTo("projects", ctx) },
  "go-progress": { icon: () => <ChartColumn size={15} />, perform: (ctx) => goTo("progress", ctx) },
  "go-team": { icon: (team) => <TeamIcon team={team!} size={15} />, perform: (ctx) => goTo("team-all", ctx) },
  "go-backlog": { icon: () => <Layers size={15} />, perform: (ctx) => goTo("team-backlog", ctx) },
  "go-cycles": { icon: () => <CycleIcon size={15} progress={0.5} />, perform: (ctx) => goTo("team-cycles", ctx) },
  "go-search": { icon: () => <Search size={15} />, perform: (ctx) => goTo("search", ctx) },
  "go-settings": { icon: () => <Settings size={15} />, perform: (ctx) => goTo("settings", ctx) },
  "go-profile": { icon: () => <User size={15} />, perform: (ctx) => goTo("settings-profile", ctx) },
  "go-help": { icon: () => <PlayCircle size={15} />, perform: (ctx) => goTo("help", ctx) },
  "open-assistant": { icon: () => <Sparkles size={15} />, perform: () => openAssistant() },
  shortcuts: { icon: () => <Keyboard size={15} />, perform: () => useUI.setState({ shortcutsOpen: true }) },
  "toggle-layout": {
    icon: () => <Columns3 size={15} />,
    perform: () => window.dispatchEvent(new CustomEvent("sen:toggle-layout")),
  },
  "theme-dark": { icon: () => <Moon size={15} />, perform: () => setTheme("dark") },
  "theme-light": { icon: () => <Sun size={15} />, perform: () => setTheme("light") },
  "theme-system": { icon: () => <Monitor size={15} />, perform: () => setTheme("system") },
  undo: { icon: () => <Undo2 size={15} />, perform: () => undo() },
  "install-app": { icon: () => <Download size={15} />, perform: () => installApp() },
  "update-app": { icon: () => <RefreshCw size={15} />, perform: () => applyUpdate() },
  logout: { icon: () => <LogOut size={15} />, perform: () => logout() },
} satisfies Record<CommandId, CommandAction>;

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
  const accounts = useSession((s) => s.accounts);
  const canInstall = usePWA((s) => !!s.installPrompt);
  const updateReady = usePWA((s) => s.updateReady);
  const assistantStatus = useAssistant((s) => s.status);
  const assistantOn = !(typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) && assistantStatus?.enabled === true;
  const canAskAssistant = assistantOn && (assistantStatus?.remaining ?? 0) > 0;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const targets = useMemo(() => targetIssueIds().filter((id) => issues[id]), []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => useUI.setState({ paletteOpen: false });
  const go = (path: string) => navigate(`/${ws}${path}`);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const issueGroup =
      targets.length === 1 ? `課題 ${identifier(issues[targets[0]], teamsMap)}` : targets.length ? `${targets.length}件の課題` : "";
    const ctxBase: PaletteCtx = { navigate, ws, targets, issues, teams: teamsMap, meId };
    const visible = (raw: (typeof COMMANDS)[number]) => {
      const def: CommandDef = raw;
      if (def.context && !targets.length) return false;
      if (def.context === "single-issue" && targets.length !== 1) return false;
      if (raw.id === "install-app" && !canInstall) return false;
      if (raw.id === "update-app" && !updateReady) return false;
      if (raw.id === "open-assistant" && !assistantOn) return false;
      return true;
    };
    const push = (raw: (typeof COMMANDS)[number], team?: Team) => {
      const def: CommandDef = raw;
      const action = COMMAND_RUNTIME[raw.id];
      const view = presentCommand(def, team);
      const item: Command = {
        id: view.id,
        label: view.label,
        group: def.context ? issueGroup : def.group,
        icon: action.icon(team),
        perform: () => action.perform({ ...ctxBase, team }),
      };
      if (view.combo) item.combo = view.combo;
      if (view.keywords) item.keywords = view.keywords;
      list.push(item);
    };
    for (let i = 0; i < COMMANDS.length; ) {
      const raw = COMMANDS[i];
      if (!visible(raw)) {
        i++;
        continue;
      }
      const def: CommandDef = raw;
      // 隣り合う team コマンドは、チームごとにまとめて出す（新しいサイクルはチーム順、移動は課題・バックログ・サイクルの順）
      if (def.team) {
        const batch: (typeof COMMANDS)[number][] = [];
        while (i < COMMANDS.length && (COMMANDS[i] as CommandDef).team) {
          if (visible(COMMANDS[i])) batch.push(COMMANDS[i]);
          i++;
        }
        for (const t of teams) {
          for (const cmd of batch) push(cmd, t);
        }
        continue;
      }
      push(raw);
      // 課題どうしの関係は一覧の外（Relations.tsx）。従来どおり parent の直後に出す
      if (raw.id === "parent" && targets.length) {
        list.push(
          ...RELATION_ACTIONS.map((a) => ({
            id: `relation-${a.kind}`,
            label: a.label,
            group: issueGroup,
            icon: RELATION_ICON[a.kind],
            combo: a.combo,
            keywords: a.keywords,
            perform: () => openRelationPicker(targets, a.kind),
          })),
        );
      }
      i++;
    }
    for (const a of accounts) {
      if (a.current) continue;
      list.push({
        id: `switch-account-${a.id}`,
        label: `${a.name}（${a.email}）に切り替え`,
        group: "アカウント",
        icon: <ArrowLeftRight size={15} />,
        keywords: "account switch アカウント 切り替え",
        perform: () => {
          switchAccount(a.id).catch((e) => toast((e as Error).message, { kind: "error" }));
        },
      });
    }
    if (!(typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__)) {
      list.push({
        id: "add-account",
        label: "別のアカウントを追加",
        group: "アカウント",
        icon: <UserPlus size={15} />,
        keywords: "account add login アカウント 追加",
        perform: () => {
          addAccount().catch((e) => toast((e as Error).message, { kind: "error" }));
        },
      });
    }
    return list;
  }, [targets, issues, teamsMap, teams, meId, ws, canInstall, updateReady, assistantOn, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const list = [...cmds, ...issueHits];
    if (q.trim() && canAskAssistant) {
      list.push({
        id: "ask-ai",
        label: `AI に聞く：「${q}」`,
        group: "ヘルプ",
        icon: <Sparkles size={15} />,
        command: "ask-ai",
        perform: () => openAssistant(q),
      });
    }
    return list;
  }, [commands, q, issues, teamsMap, canAskAssistant]); // eslint-disable-line react-hooks/exhaustive-deps

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
                data-command={c.command}
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
