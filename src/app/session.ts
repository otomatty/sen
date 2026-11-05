import { create } from "zustand";
import type { DeviceAccount, Me, PendingInvitation, WorkspaceSummary } from "../../shared/types";
import { api, ApiError, setAccountSwitchedHandler, setBearerToken, setCurrentUserId } from "../lib/api";
import { confirmDialog } from "../components/ConfirmDialog";
import { hasCommentDraft } from "../features/issues/CommentComposer";
import { hasIssueDraft } from "../features/issues/CreateIssueModal";
import { engine } from "../store/engine";
import { readLocal, writeLocal } from "../lib/utils";
import { clearSnapshots, clearSnapshotsFor } from "../store/cache";
import { useData } from "../store/data";
import { dismissToast, toast } from "../store/ui";
import { lockScreen, waitForSync } from "./guard";

interface SessionState {
  status: "unknown" | "authed" | "anon";
  user: Me | null;
  workspaces: WorkspaceSummary[];
  /** ログイン中の人あての招待。古いキャッシュには無いので、無いときは [] */
  invitations: PendingInvitation[];
  defaultWorkspaceId: string | null;
  accounts: DeviceAccount[];
  /** 一覧の取得に一度でも成功したか。未取得・失敗のときはログアウトを分けて出す */
  accountsLoaded: boolean;
  maxAccounts: number;
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
  accounts: [],
  accountsLoaded: false,
  maxAccounts: 5,
}));

function pendingInvitations(list: PendingInvitation[] | undefined): PendingInvitation[] {
  return Array.isArray(list) ? list : [];
}

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
  | { type: "account-changed"; userId?: string }
  | { type: "pending-query"; id: string }
  | { type: "pending-reply"; id: string; pending: number; drafts: boolean };

function postSession(message: SessionMessage) {
  sessionChannel?.postMessage(message);
}

function notifyOtherTabs(userId?: string) {
  postSession(userId ? { type: "account-changed", userId } : { type: "account-changed" });
}

let sessionSyncReady = false;
let handlingAccountChange = false;

/**
 * 別のタブでアカウントが替わった。
 * 未送信の変更も書きかけもなければ開き直す。あれば、捨てる前に元のアカウントへ戻すか聞く。
 * 戻せなかったときは残したまま、もう一度聞く。キャンセルしたときだけ捨てて開き直す。
 */
async function handleAccountChangedElsewhere() {
  if (handlingAccountChange) return;
  handlingAccountChange = true;
  // 409 のときは api がこの関数を呼んだあとで engine の catch に入る。先に止めて、変更が捨てられないようにする
  engine.pause();
  // 離れたときの保存と、説明の 700 ミリ秒後の保存が送信待ちに入るのを待つ。待っているあいだは新しく入力させない
  (document.activeElement as HTMLElement | null)?.blur?.();
  lockScreen(true);
  await new Promise((r) => setTimeout(r, 800));
  lockScreen(false);
  const pending = useData.getState().pendingCount;
  const drafts = hasIssueDraft() || hasCommentDraft();
  const me = useSession.getState().user;
  if ((pending === 0 && !drafts) || !me) {
    engine.stop();
    window.location.assign("/");
    return;
  }
  let error: string | null = null;
  for (;;) {
    const ok = await confirmDialog(
      error
        ? {
            title: "元のアカウントに戻せませんでした",
            message: `${error}。もう一度試しますか？ キャンセルすると、${pending > 0 ? `まだ送っていない変更（${pending}件）` : "書きかけのコメントや作成中の課題"}を捨てて開き直します。`,
            confirmLabel: "もう一度試す",
          }
        : {
            title: "別のタブでアカウントが切り替わりました",
            message:
              pending > 0
                ? `このタブには、まだ送っていない変更が ${pending}件あります。元のアカウント（${me.name}）に戻して送りますか？ キャンセルすると、変更を捨てて開き直します。${drafts ? "書きかけの内容も残っています。" : ""}`
                : `このタブには、書きかけのコメントや作成中の課題があります。元のアカウント（${me.name}）に戻しますか？ キャンセルすると、捨てて開き直します。`,
            confirmLabel: pending > 0 ? "元のアカウントに戻して送る" : "元のアカウントに戻す",
          },
    );
    if (!ok) {
      engine.stop();
      window.location.assign("/");
      return;
    }
    try {
      await api("/api/accounts/switch", { body: { userId: me.id } });
    } catch (e) {
      error = e instanceof Error ? e.message : "エラーが発生しました";
      continue;
    }
    notifyOtherTabs(me.id);
    handlingAccountChange = false;
    engine.resume();
    toast(pending > 0 ? `元のアカウント（${me.name}）に戻しました。変更を送っています` : `元のアカウント（${me.name}）に戻しました`);
    return;
  }
}

/** 他のタブの切り替えと、このタブのリクエストが別アカウントになったことを受け取る。何度呼んでも 1 回だけ */
export function initSessionSync() {
  if (DEMO || sessionSyncReady) return;
  sessionSyncReady = true;
  if (sessionChannel) {
    const channel = sessionChannel;
    channel.onmessage = (ev) => {
      const data = ev.data as SessionMessage | undefined;
      if (data?.type === "pending-query") {
        postSession({ type: "pending-reply", id: data.id, pending: useData.getState().pendingCount, drafts: hasIssueDraft() || hasCommentDraft() });
        return;
      }
      if (data?.type !== "account-changed") return;
      const cur = useSession.getState();
      // 起動中・ログインしていないタブは、このあと今のアカウントを読むので何もしない（開いている画面を保つ）
      if (cur.status !== "authed") return;
      // 知らせの先が今のアカウントなら、このタブはすでにそのアカウントなので何もしない
      if (data.userId && data.userId === cur.user?.id) return;
      void handleAccountChangedElsewhere();
    };
  }
  setAccountSwitchedHandler(() => {
    void handleAccountChangedElsewhere();
  });
}

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
      setCurrentUserId(null);
      useSession.setState({ status: "anon", user: null, workspaces: [], invitations: [], defaultWorkspaceId: null, accounts: [], accountsLoaded: false });
      return null;
    }
    const invitations = pendingInvitations(res.invitations);
    const defaultWorkspaceId = res.defaultWorkspaceId ?? null;
    // Google から戻ってきたときなど、ほかのタブが古いアカウントのままにならないよう知らせる
    const previousId = readLocal<{ user?: { id?: string } } | null>(SESSION_CACHE, null)?.user?.id;
    if (previousId && previousId !== res.user.id) notifyOtherTabs(res.user.id);
    writeSessionCache(res.user, res.workspaces, defaultWorkspaceId, invitations);
    setCurrentUserId(res.user.id);
    useSession.setState({ status: "authed", user: res.user, workspaces: res.workspaces, invitations, defaultWorkspaceId });
    void refreshAccounts();
    return { ...res, invitations, defaultWorkspaceId };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setCurrentUserId(null);
      useSession.setState({ status: "anon", user: null, workspaces: [], invitations: [], defaultWorkspaceId: null, accounts: [], accountsLoaded: false });
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
      setCurrentUserId(cached.user.id);
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

let accountsRefresh: Promise<boolean> | null = null;

/** このブラウザでログインしているアカウントの一覧を取り直す。成功したら true、失敗かデモなら false */
export async function refreshAccounts(): Promise<boolean> {
  if (DEMO) return false;
  if (accountsRefresh) return accountsRefresh;
  accountsRefresh = (async () => {
    try {
      const res = await api<{ accounts: DeviceAccount[]; max: number }>("/api/accounts", {
        signal: AbortSignal.timeout(10_000),
      });
      useSession.setState({ accounts: res.accounts, maxAccounts: res.max, accountsLoaded: true });
      return true;
    } catch {
      // 通信エラー（オフライン含む）のときは今の一覧をそのまま使う
      return false;
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

// 切り替えると、ほかのタブは読み込み直すので、送っていない変更や書きかけが消える。切り替えたあとは別のアカウントになるので送り直せない。だから切り替える前に確かめる
async function queryOtherTabs(): Promise<{ pending: number; drafts: boolean }> {
  if (!sessionChannel) return { pending: 0, drafts: false };
  const channel = sessionChannel;
  const id = crypto.randomUUID();
  let pending = 0;
  let drafts = false;
  const onMessage = (ev: MessageEvent) => {
    const data = ev.data as SessionMessage | undefined;
    if (data?.type === "pending-reply" && data.id === id) {
      pending += data.pending;
      if (data.drafts) drafts = true;
    }
  };
  channel.addEventListener("message", onMessage);
  try {
    postSession({ type: "pending-query", id });
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    channel.removeEventListener("message", onMessage);
  }
  return { pending, drafts };
}

/** 切り替える前に、書きかけを捨ててよいか確かめ、画面を止めて、保存と送信が終わるのを待つ。終わったら元に戻す関数を返す。やめたときは null */
async function prepareAccountChange(label: string): Promise<(() => void) | null> {
  const reason = canChangeAccount();
  if (reason) throw new Error(reason);
  const other = await queryOtherTabs();
  if (other.pending > 0) throw new Error(`別のタブに未送信の変更（${other.pending}件）があります。送り終わってから切り替えてください`);
  // 読み込み直すと消える書きかけの内容は、画面を止める前に確かめる。ほかのタブの書きかけも含む
  if (hasIssueDraft() || hasCommentDraft() || other.drafts) {
    const ok = await confirmDialog({
      title: "書きかけの内容があります",
      message: "作成中の課題や書きかけのコメントは、アカウントを切り替えると失われます。ほかのタブのものも含みます。続けますか？",
      confirmLabel: "続ける",
      danger: true,
    });
    if (!ok) return null;
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  lockScreen(true);
  const progress = toast(label, { duration: Infinity });
  const release = () => {
    lockScreen(false);
    dismissToast(progress);
  };
  try {
    // 入力が止まってから保存する欄（説明文は 700 ミリ秒後）の送信が始まるのを待ち、送り終わるまで待つ
    await new Promise((r) => setTimeout(r, 800));
    if (!(await waitForSync(10_000))) throw new Error("送信できていない変更があります。同期が終わってから、もう一度お試しください");
    const again = await queryOtherTabs();
    if (again.pending > 0) throw new Error(`別のタブに未送信の変更（${again.pending}件）があります。送り終わってから切り替えてください`);
  } catch (e) {
    release();
    throw e;
  }
  return release;
}

/** このブラウザに記録済みのアカウントへ切り替えて、最初から開き直す */
export async function switchAccount(userId: string) {
  const release = await prepareAccountChange("アカウントを切り替えています…");
  if (!release) return;
  try {
    await api("/api/accounts/switch", { body: { userId } });
  } catch (e) {
    release();
    throw e;
  }
  engine.stop();
  notifyOtherTabs(userId);
  window.location.assign("/");
}

/** 別のアカウントを追加する前の準備。上限・未送信の変更・書きかけを確かめ、画面を止め、今のアカウントを記録に加える。やめたら null。終わったら元に戻す関数を返す */
export async function prepareAddAccount(): Promise<(() => void) | null> {
  const { accounts, maxAccounts } = useSession.getState();
  if (accounts.length >= maxAccounts) throw new Error(`同時にログインできるのは ${maxAccounts} つまでです`);
  const release = await prepareAccountChange("Google のアカウント選択へ移ります…");
  if (!release) return null;
  try {
    if (!(await refreshAccounts())) throw new Error("今のアカウントを記録できませんでした。通信できる状態で、もう一度お試しください");
    const next = useSession.getState();
    if (next.accounts.length >= next.maxAccounts) throw new Error(`同時にログインできるのは ${next.maxAccounts} つまでです`);
  } catch (e) {
    release();
    throw e;
  }
  return release;
}

/** 今のアカウントを残したまま、別の Google アカウントを追加する */
export async function addAccount() {
  if (DEMO) return;
  const release = await prepareAddAccount();
  if (!release) return;
  try {
    await signInWithGoogle({ callbackURL: "/", errorCallbackURL: window.location.pathname });
  } catch (e) {
    release();
    throw e;
  }
}

/** 今のアカウントだけログアウトし、残ったアカウントで開き直す */
export async function logoutCurrentAccount() {
  const release = await prepareAccountChange("ログアウトしています…");
  if (!release) return;
  const user = useSession.getState().user;
  try {
    await api("/api/accounts/sign-out", { body: {} });
  } catch (e) {
    release();
    throw e;
  }
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
  useSession.setState({ status: "anon", user: null, workspaces: [], invitations: [], defaultWorkspaceId: null, accounts: [], accountsLoaded: false });
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
