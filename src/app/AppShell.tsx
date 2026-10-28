import { useEffect } from "react";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { X } from "lucide-react";
import { useData } from "../store/data";
import { engine } from "../store/engine";
import { archiveIssues, branchName, restoreIssues, undo, updateIssues } from "../store/actions";
import { dismissToast, openCreateIssue, openPalette, openPicker, targetIssueIds, toast, useUI } from "../store/ui";
import { SCOPE, useHotkeys } from "../lib/hotkeys";
import { copyText, cx, identifier } from "../lib/utils";
import { Spinner } from "../components/ui";
import { Logo } from "../components/icons";
import { PickerHost } from "../components/pickers";
import { CommandPalette } from "../features/palette/CommandPalette";
import { CreateIssueModal } from "../features/issues/CreateIssueModal";
import { IssueContextMenu, SelectionBar } from "../features/issues/IssueOverlays";
import { ShortcutsHelp } from "../features/help/ShortcutsHelp";
import { VideoModal } from "../features/help/VideoModal";
import { WelcomeModal } from "../features/help/WelcomeModal";
import { Sidebar } from "./Sidebar";
import { preloadEditor } from "../components/Editor";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useCurrentTeamId } from "./hooks";
import { setLastWorkspaceKey, useSession } from "./session";
import { openRelationPicker, RELATION_ACTIONS } from "../features/issues/Relations";

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", t.kind)} data-testid="toast">
          <span>{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="閉じる">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function GlobalShortcuts() {
  const navigate = useNavigate();
  const { ws } = useParams();
  const teamId = useCurrentTeamId();
  const teams = useData((s) => s.teams);
  const go = (p: string) => navigate(`/${ws}${p}`);
  const teamKey = (teamId && teams[teamId]?.key) || Object.values(teams)[0]?.key;

  useHotkeys("mod+k", () => openPalette(), { allowInInput: true });
  useHotkeys("c", () => openCreateIssue({ teamId }));
  useHotkeys("/", () => go("/search"));
  useHotkeys("?", () => useUI.setState((s) => ({ shortcutsOpen: !s.shortcutsOpen })));
  useHotkeys("g i", () => go("/inbox"));
  useHotkeys("g m", () => go("/my-issues"));
  useHotkeys("g p", () => go("/projects"));
  useHotkeys("g s", () => go("/settings/workspace"));
  useHotkeys("g h", () => go("/help"));
  useHotkeys("g e", () => teamKey && go(`/team/${teamKey}/all`));
  useHotkeys("g a", () => teamKey && go(`/team/${teamKey}/active`));
  useHotkeys("g b", () => teamKey && go(`/team/${teamKey}/backlog`));
  useHotkeys("g c", () => teamKey && go(`/team/${teamKey}/cycles`));
  useHotkeys("mod+z", () => undo());

  // フォーカスした課題のコメントと履歴を先読みして、開いた瞬間に表示できるようにする
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useUI.subscribe((s, prev) => {
      if (!s.focusedIssueId || s.focusedIssueId === prev.focusedIssueId) return;
      const id = s.focusedIssueId;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => engine.loadThread(id), 180);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // フォーカス中（または選択中）の課題に対する操作
  const withTargets = (fn: (ids: string[]) => void) => () => {
    const ids = targetIssueIds().filter((id) => useData.getState().issues[id]);
    if (!ids.length) return false;
    fn(ids);
  };
  const pick = (kind: Parameters<typeof openPicker>[0]["kind"]) => withTargets((ids) => openPicker({ kind, issueIds: ids, anchor: null }));
  useHotkeys("s", pick("status"), { scope: SCOPE.global });
  useHotkeys("p", pick("priority"));
  useHotkeys("a", pick("assignee"));
  useHotkeys("l", pick("labels"));
  useHotkeys("shift+p", pick("project"));
  useHotkeys("shift+c", pick("cycle"));
  useHotkeys("shift+d", pick("dueDate"));
  useHotkeys("shift+e", pick("estimate"));
  // 課題どうしの関係（M のあとに B / X / R / M）
  for (const a of RELATION_ACTIONS) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- RELATION_ACTIONS は固定の配列なので呼び出し順は変わらない
    useHotkeys(a.combo, withTargets((ids) => openRelationPicker(ids, a.kind)));
  }
  useHotkeys(
    "i",
    withTargets((ids) => {
      const me = useData.getState().meId;
      if (me) {
        updateIssues(ids, { assigneeId: me });
        toast(ids.length > 1 ? `${ids.length}件を自分に割り当てました` : "自分に割り当てました");
      }
    }),
  );
  useHotkeys(
    "mod+.",
    withTargets((ids) => {
      const d = useData.getState();
      const text = ids.map((id) => identifier(d.issues[id], d.teams)).join(", ");
      copyText(text).then(() => toast(`${text} をコピーしました`));
    }),
  );
  useHotkeys(
    "mod+shift+.",
    withTargets((ids) => {
      const b = branchName(ids[0]);
      copyText(b).then(() => toast(`${b} をコピーしました`));
    }),
  );
  useHotkeys(
    ["mod+backspace", "mod+delete"],
    withTargets((ids) => {
      archiveIssues(ids);
      useUI.setState({ selectedIssueIds: [] });
      toast(ids.length > 1 ? `${ids.length}件の課題を削除しました` : "課題を削除しました", {
        action: { label: "元に戻す", run: () => restoreIssues(ids) },
      });
    }),
  );
  return null;
}

export function AppShell() {
  const { ws } = useParams();
  const status = useData((s) => s.status);
  const error = useData((s) => s.error);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const session = useSession((s) => s.status);
  const navigate = useNavigate();
  const location = useLocation();
  const meSettings = useData((s) => (s.meId ? (s.users[s.meId] as { settings?: { welcomeDismissed?: boolean } })?.settings : undefined));

  useEffect(() => {
    if (!ws) return;
    setLastWorkspaceKey(ws);
    engine.start(ws, useSession.getState().user?.id);
  }, [ws]);

  useEffect(() => {
    const off1 = engine.onError((msg) => toast(msg, { kind: "error" }));
    const off2 = engine.onUnauthorized(() => {
      useSession.setState({ status: "anon" });
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
    });
    return () => {
      off1();
      off2();
    };
  }, [navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status === "ready" && meSettings && !meSettings.welcomeDismissed && !sessionStorage.getItem("sen:welcome-shown")) {
      try {
        sessionStorage.setItem("sen:welcome-shown", "1");
      } catch {
        // noop
      }
      useUI.setState({ welcomeOpen: true });
    }
  }, [status, meSettings]);

  // 起動して落ち着いたら、エディタとボードを先読みしておく
  useEffect(() => {
    if (status !== "ready") return;
    const run = () => {
      preloadEditor();
      import("../features/issues/IssueBoard");
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1200);
  }, [status]);

  // アプリのショートカット「新しい課題を作成」から開いたときは、作成画面を出す
  useEffect(() => {
    if (status !== "ready" || !(location.state as { createIssue?: boolean } | null)?.createIssue) return;
    navigate(location.pathname, { replace: true, state: null });
    openCreateIssue();
  }, [status, location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // 画面遷移したら選択とポップアップを閉じる
  useEffect(() => {
    useUI.setState({ selectedIssueIds: [], contextMenu: null, picker: null, sidebarOpen: false });
  }, [location.pathname]);

  if (session === "anon") return null;

  if (status === "error") {
    return (
      <div className="fullscreen-center">
        <Logo size={32} />
        <p className="error-text">{error}</p>
        <div className="error-actions">
          <button className="btn btn-primary btn-md" onClick={() => window.location.reload()}>
            再読み込み
          </button>
          <button className="btn btn-secondary btn-md" onClick={() => navigate("/")}>
            トップに戻る
          </button>
        </div>
      </div>
    );
  }
  if (status !== "ready") {
    return (
      <div className="fullscreen-center" data-testid="app-loading">
        <Logo size={32} />
        <Spinner size={18} />
      </div>
    );
  }

  return (
    <div className={cx("app", sidebarOpen && "sidebar-open")} data-testid="app">
      <Sidebar />
      <div className="sidebar-scrim" onClick={() => useUI.setState({ sidebarOpen: false })} />
      <main className="main">
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <GlobalShortcuts />
      <SelectionBar />
      <PickerHost />
      <IssueContextMenu />
      <CommandPalette />
      <CreateIssueModal />
      <ShortcutsHelp />
      <VideoModal />
      <WelcomeModal />
    </div>
  );
}
