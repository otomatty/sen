import { create } from "zustand";
import type { Me, PendingInvitation, WorkspaceSummary } from "../../shared/types";
import { api, ApiError, setBearerToken } from "../lib/api";
import { engine } from "../store/engine";
import { readLocal, writeLocal } from "../lib/utils";
import { clearSnapshots } from "../store/cache";
import { clearAllIssueDrafts } from "../features/issues/issueDraft";

interface SessionState {
  status: "unknown" | "authed" | "anon";
  user: Me | null;
  workspaces: WorkspaceSummary[];
  /** ログイン中の人あての招待。古いキャッシュには無いので、無いときは [] */
  invitations: PendingInvitation[];
  defaultWorkspaceId: string | null;
}

interface MeResponse {
  user: Me | null;
  workspaces: WorkspaceSummary[];
  invitations?: PendingInvitation[];
  defaultWorkspaceId?: string | null;
}

export const useSession = create<SessionState>(() => ({
  status: "unknown",
  user: null,
  workspaces: [],
  invitations: [],
  defaultWorkspaceId: null,
}));

function pendingInvitations(list: PendingInvitation[] | undefined): PendingInvitation[] {
  return Array.isArray(list) ? list : [];
}

const DEMO = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;

const SESSION_CACHE = "sen:session";

function writeSessionCache(
  user: { id: string; name: string },
  workspaces: WorkspaceSummary[],
  defaultWorkspaceId: string | null,
  invitations: PendingInvitation[],
) {
  writeLocal(SESSION_CACHE, { user: { id: user.id, name: user.name }, workspaces, defaultWorkspaceId, invitations });
}

export async function loadSession() {
  try {
    const res = await api<MeResponse>("/api/me");
    if (!res.user) {
      writeLocal(SESSION_CACHE, null);
      useSession.setState({ status: "anon", user: null, workspaces: [], invitations: [], defaultWorkspaceId: null });
      return null;
    }
    const invitations = pendingInvitations(res.invitations);
    const defaultWorkspaceId = res.defaultWorkspaceId ?? null;
    writeSessionCache(res.user, res.workspaces, defaultWorkspaceId, invitations);
    useSession.setState({ status: "authed", user: res.user, workspaces: res.workspaces, invitations, defaultWorkspaceId });
    return { ...res, invitations, defaultWorkspaceId };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      useSession.setState({ status: "anon", user: null, workspaces: [], invitations: [], defaultWorkspaceId: null });
      return null;
    }
    // オフライン：前回ログインしていた情報で起動し、手元のデータを表示する。
    // 古いキャッシュには招待が無いので、無ければ空にする
    const cached = readLocal<{
      user: Me;
      workspaces: WorkspaceSummary[];
      invitations?: PendingInvitation[];
      defaultWorkspaceId?: string | null;
    } | null>(SESSION_CACHE, null);
    if (e instanceof ApiError && e.status === 0 && cached) {
      const invitations = pendingInvitations(cached.invitations);
      const defaultWorkspaceId = cached.defaultWorkspaceId ?? null;
      useSession.setState({ status: "authed", user: cached.user, workspaces: cached.workspaces, invitations, defaultWorkspaceId });
      return { user: cached.user, workspaces: cached.workspaces, invitations, defaultWorkspaceId };
    }
    throw e;
  }
}

/** ログイン中の人あての招待を受け、参加したワークスペースのキーを返す */
export async function acceptPendingInvitation(id: string): Promise<string> {
  const res = await api<{ workspaceKey: string }>(`/api/me/invitations/${id}/accept`, { body: {} });
  await loadSession();
  return res.workspaceKey;
}

let workspacesRefresh: Promise<void> | null = null;
// 既定の保存が始まった回数。遅れて届く取り直しが、その間に保存した値を上書きしないために数える。
let defaultWorkspaceSaves = 0;

// 参加一覧はワークスペースごとのスナップショットに入れず、ユーザー単位のこの一覧（/api/me）だけを正とする。
// メニューを開いたときに取り直し、別のタブや端末であとから参加したワークスペースも反映する。
export async function refreshWorkspaces(): Promise<void> {
  if (workspacesRefresh) return workspacesRefresh;
  workspacesRefresh = (async () => {
    const savesAtStart = defaultWorkspaceSaves;
    try {
      // 応答が無いまま待ち続けると、使い回す Promise が終わらず次回も取り直せない。
      const res = await api<MeResponse>("/api/me", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.user) return;
      const cur = useSession.getState();
      if (cur.status !== "authed" || cur.user?.id !== res.user.id) return;
      const invitations = pendingInvitations(res.invitations);
      // 取り直しの途中で既定の保存が始まっていたら、応答は保存前の値なので使わない。
      // 一覧だけ更新し、defaultWorkspaceId は今の値のまま残してキャッシュにも書く。
      const defaultWorkspaceId = savesAtStart === defaultWorkspaceSaves ? (res.defaultWorkspaceId ?? null) : cur.defaultWorkspaceId;
      writeSessionCache(res.user, res.workspaces, defaultWorkspaceId, invitations);
      useSession.setState({ workspaces: res.workspaces, invitations, defaultWorkspaceId });
    } catch {
      // 通信エラー（オフライン含む）のときは今の一覧をそのまま使う
    } finally {
      workspacesRefresh = null;
    }
  })();
  return workspacesRefresh;
}

function rememberToken(token?: string) {
  if (DEMO && token) {
    setBearerToken(token);
    writeLocal("sen:demo-token", token);
    writeLocal("sen:demo-logged-out", false);
  }
}

export function restoreDemoToken() {
  if (!DEMO) return;
  const t = readLocal<string | null>("sen:demo-token", null);
  if (t) setBearerToken(t);
}

/** Google のログイン画面へ移る。ログインできたら callbackURL、失敗したら errorCallbackURL（?error=...）に戻ってくる */
export async function signInWithGoogle(opts: { callbackURL: string; errorCallbackURL: string }) {
  const res = await api<{ url: string }>("/api/auth/sign-in/social", { body: { provider: "google", ...opts } });
  window.location.assign(res.url);
}

/** 開発用のログイン（DEV_TOOLS=1 の環境だけ。ブラウザ内デモで使う） */
export async function devSignIn(email: string, name: string) {
  const res = await api<{ token?: string }>("/api/auth/dev/sign-in", { body: { email, name } });
  rememberToken(res.token);
  return loadSession();
}

/** セッションと手元のデータを消す（画面の移動はしない） */
export async function signOut() {
  try {
    await api("/api/auth/sign-out", { body: {} });
  } catch {
    // 失敗しても画面上はログアウトさせる
  }
  engine.stop();
  await clearSnapshots();
  // 共用のパソコンで、ログアウト後に書きかけの課題が残らないようにする
  clearAllIssueDrafts();
  writeLocal(SESSION_CACHE, null);
  if (DEMO) {
    setBearerToken(null);
    writeLocal("sen:demo-token", null);
    writeLocal("sen:demo-logged-out", true);
  }
  useSession.setState({ status: "anon", user: null, workspaces: [], invitations: [], defaultWorkspaceId: null });
}

export async function logout() {
  await signOut();
  if (!DEMO) window.location.assign("/login");
}

export function lastWorkspaceKey(): string | null {
  return readLocal<string | null>("sen:last-ws", null);
}
export function setLastWorkspaceKey(key: string) {
  writeLocal("sen:last-ws", key);
}

/** 開くワークスペースの urlKey。既定（参加中のもの）→ 最後に開いたもの → 一覧の先頭 */
export function pickWorkspaceKey(workspaces: WorkspaceSummary[], defaultWorkspaceId: string | null): string | null {
  const preferred = defaultWorkspaceId ? workspaces.find((w) => w.id === defaultWorkspaceId) : undefined;
  if (preferred) return preferred.urlKey;
  const last = lastWorkspaceKey();
  if (last && workspaces.some((w) => w.urlKey === last)) return last;
  return workspaces[0]?.urlKey ?? null;
}

/** 最初に開くワークスペースを保存する。解除するときは null */
export async function setDefaultWorkspace(workspaceId: string | null): Promise<void> {
  defaultWorkspaceSaves += 1;
  const res = await api<{ ok: true; defaultWorkspaceId: string | null }>("/api/me/default-workspace", { body: { workspaceId } });
  const defaultWorkspaceId = res.defaultWorkspaceId ?? null;
  const cur = useSession.getState();
  if (cur.status !== "authed" || !cur.user) return;
  useSession.setState({ defaultWorkspaceId });
  writeSessionCache(cur.user, cur.workspaces, defaultWorkspaceId, cur.invitations);
}
