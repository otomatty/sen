import { useEffect } from "react";
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { AppShell, Toasts } from "./app/AppShell";
import { initSessionSync, loadSession, pickWorkspaceKey, useSession } from "./app/session";
import { OAuthConsentPage } from "./features/auth/OAuthConsentPage";
import { InvitePage, LoginPage, NewWorkspacePage } from "./features/auth/AuthPages";
import { IssuePage, MyIssuesPage, SearchPage, TeamIssuesPage, WorkspaceHome } from "./features/issues/pages";
import { InboxPage } from "./features/inbox/InboxPage";
import { ProjectsPage } from "./features/projects/ProjectsPage";
import { ProgressPage } from "./features/progress/ProgressPage";
import { ProjectPage } from "./features/projects/ProjectPage";
import { CyclePage, CyclesPage } from "./features/cycles/CyclesPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { HelpPage } from "./features/help/HelpPage";
import { Spinner } from "./components/ui";
import { Logo } from "./components/icons";
import { ConfirmHost } from "./components/ConfirmDialog";

/** インストールしたアプリのショートカット（manifest.webmanifest の shortcuts）の行き先。/?open=inbox のように開く */
const SHORTCUTS: Record<string, string> = {
  "new-issue": "/my-issues/assigned",
  inbox: "/inbox",
  "my-issues": "/my-issues",
  search: "/search",
};

function Root() {
  const session = useSession();
  const [params] = useSearchParams();
  const open = params.get("open");
  const shortcut = open && Object.hasOwn(SHORTCUTS, open) ? open : null;
  if (session.status === "unknown") return <Splash />;
  if (session.status === "anon") {
    return <Navigate to={shortcut ? `/login?next=${encodeURIComponent(`/?open=${shortcut}`)}` : "/login"} replace />;
  }
  const key = pickWorkspaceKey(session.workspaces, session.defaultWorkspaceId);
  if (!key) return <Navigate to="/new-workspace" replace />;
  if (shortcut) return <Navigate to={`/${key}${SHORTCUTS[shortcut]}`} state={shortcut === "new-issue" ? { createIssue: true } : null} replace />;
  return <Navigate to={`/${key}/my-issues`} replace />;
}

function Splash() {
  return (
    <div className="fullscreen-center">
      <Logo size={32} />
      <Spinner size={18} />
    </div>
  );
}

/** ログインが必要な画面のガード */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const location = useLocation();
  if (status === "unknown") return <Splash />;
  if (status === "anon") return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

/** ログイン済みならログイン画面を飛ばす */
function GuestOnly({ children }: { children: React.ReactNode }) {
  const status = useSession((s) => s.status);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const destination = next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
  useEffect(() => {
    if (status === "authed") navigate(destination, { replace: true });
  }, [status, navigate, destination]);
  if (status === "unknown") return <Splash />;
  return <>{children}</>;
}

function AppRoutes() {
  useEffect(() => {
    initSessionSync();
    loadSession().catch(() => useSession.setState({ status: "anon", invitations: [], defaultWorkspaceId: null, accounts: [] }));
  }, []);
  return (
    <>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route
          path="/login"
          element={
            <GuestOnly>
              <LoginPage />
            </GuestOnly>
          }
        />
        {/* ログインは Google のみ。初めての人もログイン画面からアカウントを作る */}
        <Route path="/signup" element={<Navigate to="/login" replace />} />
        <Route path="/oauth/consent" element={<OAuthConsentPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route
          path="/new-workspace"
          element={
            <RequireAuth>
              <NewWorkspacePage />
            </RequireAuth>
          }
        />
        <Route
          path="/:ws"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<WorkspaceHome />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="my-issues" element={<Navigate to="assigned" replace />} />
          <Route path="my-issues/:tab" element={<MyIssuesPage />} />
          <Route path="team/:teamKey" element={<TeamIssuesPage />} />
          <Route path="team/:teamKey/cycles" element={<CyclesPage />} />
          <Route path="team/:teamKey/cycle/:number" element={<CyclePage />} />
          <Route path="team/:teamKey/projects" element={<ProjectsPage />} />
          <Route path="team/:teamKey/:tab" element={<TeamIssuesPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="progress" element={<ProgressPage />} />
          <Route path="progress/:tab" element={<ProgressPage />} />
          <Route path="project/:projectId" element={<ProjectPage />} />
          <Route path="project/:projectId/:tab" element={<ProjectPage />} />
          <Route path="issue/:identifier" element={<IssuePage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:section" element={<SettingsPage />} />
          <Route path="settings/:section/:id" element={<SettingsPage />} />
          <Route path="help" element={<HelpPage />} />
          <Route path="*" element={<WorkspaceHome />} />
        </Route>
      </Routes>
      <Toasts />
      <ConfirmHost />
    </>
  );
}

export function App() {
  const demo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  // ブラウザ内デモ（単一 HTML）は埋め込み先の URL に依存しないよう、メモリ上でルーティングする
  return demo ? (
    <MemoryRouter>
      <AppRoutes />
    </MemoryRouter>
  ) : (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
