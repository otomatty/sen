import { create } from "zustand";
import type { DeviceAccount, Me, WorkspaceSummary } from "../../shared/types";
import { api, ApiError, setAccountSwitchedHandler, setBearerToken, setCurrentUserId } from "../lib/api";
import { engine } from "../store/engine";
import { readLocal, writeLocal } from "../lib/utils";
import { clearSnapshots, clearSnapshotsFor } from "../store/cache";
import { useData } from "../store/data";

interface SessionState {
  status: "unknown" | "authed" | "anon";
  user: Me | null;
  workspaces: WorkspaceSummary[];
  accounts: DeviceAccount[];
  maxAccounts: number;
}

export const useSession = create<SessionState>(() => ({
  status: "unknown",
  user: null,
  workspaces: [],
  accounts: [],
  maxAccounts: 5,
}));

const DEMO = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;

const SESSION_CACHE = "sen:session";

// 別タブへ「アカウントが変わった」と知らせる。送ったタブ自身には届かない
const sessionChannel: BroadcastChannel | null = (() => {
  try {
    return new BroadcastChannel("sen:session");
  } catch {
    return null;
  }
})();

type SessionMessage =
  | { type: "account-changed" }
  | { type: "pending-query"; id: string }
  | { type: "pending-reply"; id: string; pending: number };

function postSession(message: SessionMessage) {
  sessionChannel?.postMessage(message);
}

function notifyOtherTabs() {
  postSession({ type: "account-changed" });
}

let sessionSyncReady = false;

/** 他のタブの切り替えと、このタブのリクエストが別アカウントになったことを受け取る。何度呼んでも 1 回だけ */
export function initSessionSync() {
  if (DEMO || sessionSyncReady) return;
  sessionSyncReady = true;
  if (sessionChannel) {
    const channel = sessionChannel;
    channel.onmessage = (ev) => {
      const data = ev.data as SessionMessage | undefined;
      if (data?.type === "pending-query") {
        postSession({ type: "pending-reply", id: data.id, pending: useData.getState().pendingCount });
        return;
      }
      if (data?.type !== "account-changed") return;
      engine.stop();
      window.location.assign("/");
    };
  }
  setAccountSwitchedHandler(() => {
    engine.stop();
    window.location.assign("/");
  });
}

function writeSessionCache(user: { id: string; name: string }, workspaces: WorkspaceSummary[]) {
  writeLocal(SESSION_CACHE, { user: { id: user.id, name: user.name }, workspaces });
}

export async function loadSession() {
  try {
    const res = await api<{ user: Me | null; workspaces: WorkspaceSummary[] }>("/api/me");
    if (!res.user) {
      writeLocal(SESSION_CACHE, null);
      setCurrentUserId(null);
      useSession.setState({ status: "anon", user: null, workspaces: [], accounts: [] });
      return null;
    }
    writeSessionCache(res.user, res.workspaces);
    setCurrentUserId(res.user.id);
    useSession.setState({ status: "authed", user: res.user, workspaces: res.workspaces });
    void refreshAccounts();
    return res;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setCurrentUserId(null);
      useSession.setState({ status: "anon", user: null, workspaces: [], accounts: [] });
      return null;
    }
    // オフライン：前回ログインしていた情報で起動し、手元のデータを表示する
    const cached = readLocal<{ user: Me; workspaces: WorkspaceSummary[] } | null>(SESSION_CACHE, null);
    if (e instanceof ApiError && e.status === 0 && cached) {
      setCurrentUserId(cached.user.id);
      useSession.setState({ status: "authed", user: cached.user, workspaces: cached.workspaces });
      return cached;
    }
    throw e;
  }
}

let workspacesRefresh: Promise<void> | null = null;

// 参加一覧はワークスペースごとのスナップショットに入れず、ユーザー単位のこの一覧（/api/me）だけを正とする。
// メニューを開いたときに取り直し、別のタブや端末であとから参加したワークスペースも反映する。
export async function refreshWorkspaces(): Promise<void> {
  if (workspacesRefresh) return workspacesRefresh;
  workspacesRefresh = (async () => {
    try {
      // 応答が無いまま待ち続けると、使い回す Promise が終わらず次回も取り直せない。
      const res = await api<{ user: Me | null; workspaces: WorkspaceSummary[] }>("/api/me", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.user) return;
      const cur = useSession.getState();
      if (cur.status !== "authed" || cur.user?.id !== res.user.id) return;
      writeSessionCache(res.user, res.workspaces);
      useSession.setState({ workspaces: res.workspaces });
    } catch {
      // 通信エラー（オフライン含む）のときは今の一覧をそのまま使う
    } finally {
      workspacesRefresh = null;
    }
  })();
  return workspacesRefresh;
}

let accountsRefresh: Promise<void> | null = null;

/** このブラウザでログインしているアカウントの一覧を取り直す */
export async function refreshAccounts(): Promise<void> {
  if (DEMO) return;
  if (accountsRefresh) return accountsRefresh;
  accountsRefresh = (async () => {
    try {
      const res = await api<{ accounts: DeviceAccount[]; max: number }>("/api/accounts", {
        signal: AbortSignal.timeout(10_000),
      });
      useSession.setState({ accounts: res.accounts, maxAccounts: res.max });
    } catch {
      // 通信エラー（オフライン含む）のときは今の一覧をそのまま使う
    } finally {
      accountsRefresh = null;
    }
  })();
  return accountsRefresh;
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

/** オフライン、または未送信の変更があるあいだはアカウントを変えられない。変えられるときは null */
export function canChangeAccount(): string | null {
  const { syncStatus, pendingCount } = useData.getState();
  if (syncStatus === "offline") return "オフラインのあいだは切り替えられません";
  if (pendingCount > 0) return `未送信の変更（${pendingCount}件）を送るまで切り替えられません`;
  return null;
}

// 切り替えると、ほかのタブは読み込み直すので、送っていない変更が消える。切り替えたあとは別のアカウントになるので送り直せない。だから切り替える前に確かめる
async function otherTabsBlocker(): Promise<string | null> {
  if (!sessionChannel) return null;
  const channel = sessionChannel;
  const id = crypto.randomUUID();
  let total = 0;
  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as SessionMessage | undefined;
    if (data?.type === "pending-reply" && data.id === id) total += data.pending;
  };
  channel.addEventListener("message", onMessage);
  try {
    postSession({ type: "pending-query", id });
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    channel.removeEventListener("message", onMessage);
  }
  if (total >= 1) return `別のタブに未送信の変更（${total}件）があります。送り終わってから切り替えてください`;
  return null;
}

/** このブラウザに記録済みのアカウントへ切り替えて、最初から開き直す */
export async function switchAccount(userId: string) {
  const reason = canChangeAccount();
  if (reason) throw new Error(reason);
  const other = await otherTabsBlocker();
  if (other) throw new Error(other);
  await api("/api/accounts/switch", { body: { userId } });
  engine.stop();
  notifyOtherTabs();
  window.location.assign("/");
}

/** 今のアカウントを残したまま、別の Google アカウントを追加する */
export async function addAccount() {
  if (DEMO) return;
  const reason = canChangeAccount();
  if (reason) throw new Error(reason);
  const other = await otherTabsBlocker();
  if (other) throw new Error(other);
  await refreshAccounts();
  await signInWithGoogle({ callbackURL: "/", errorCallbackURL: window.location.pathname });
}

/** 今のアカウントだけログアウトし、残ったアカウントで開き直す */
export async function logoutCurrentAccount() {
  const reason = canChangeAccount();
  if (reason) throw new Error(reason);
  const other = await otherTabsBlocker();
  if (other) throw new Error(other);
  const user = useSession.getState().user;
  await api("/api/accounts/sign-out", { body: {} });
  engine.stop();
  if (user) await clearSnapshotsFor(user.id);
  writeLocal(SESSION_CACHE, null);
  notifyOtherTabs();
  window.location.assign("/");
}

/** セッションと手元のデータを消す（画面の移動はしない）。記録しているアカウントはすべてログアウトする */
export async function signOut() {
  try {
    await api("/api/auth/sign-out", { body: {} });
  } catch {
    // 失敗しても画面上はログアウトさせる
  }
  engine.stop();
  await clearSnapshots();
  writeLocal(SESSION_CACHE, null);
  if (DEMO) {
    setBearerToken(null);
    writeLocal("sen:demo-token", null);
    writeLocal("sen:demo-logged-out", true);
  }
  setCurrentUserId(null);
  useSession.setState({ status: "anon", user: null, workspaces: [], accounts: [] });
  notifyOtherTabs();
}

export async function logout() {
  await signOut();
  if (!DEMO) window.location.assign("/login");
}

export function lastWorkspaceKey(userId = useSession.getState().user?.id): string | null {
  if (userId) {
    const own = readLocal<string | null>(`sen:last-ws:${userId}`, null);
    if (own) return own;
  }
  return readLocal<string | null>("sen:last-ws", null);
}
export function setLastWorkspaceKey(key: string) {
  const userId = useSession.getState().user?.id;
  if (userId) writeLocal(`sen:last-ws:${userId}`, key);
  else writeLocal("sen:last-ws", key);
}
