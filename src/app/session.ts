import { create } from "zustand";
import type { Me, WorkspaceSummary } from "../../shared/types";
import { api, ApiError, setBearerToken } from "../lib/api";
import { engine } from "../store/engine";
import { readLocal, writeLocal } from "../lib/utils";
import { clearSnapshots } from "../store/cache";

interface SessionState {
  status: "unknown" | "authed" | "anon";
  user: Me | null;
  workspaces: WorkspaceSummary[];
}

export const useSession = create<SessionState>(() => ({ status: "unknown", user: null, workspaces: [] }));

const DEMO = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;

const SESSION_CACHE = "sen:session";

export async function loadSession() {
  try {
    const res = await api<{ user: Me | null; workspaces: WorkspaceSummary[] }>("/api/me");
    if (!res.user) {
      writeLocal(SESSION_CACHE, null);
      useSession.setState({ status: "anon", user: null, workspaces: [] });
      return null;
    }
    writeLocal(SESSION_CACHE, { user: { id: res.user.id, name: res.user.name }, workspaces: res.workspaces });
    useSession.setState({ status: "authed", user: res.user, workspaces: res.workspaces });
    return res;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      useSession.setState({ status: "anon", user: null, workspaces: [] });
      return null;
    }
    // オフライン：前回ログインしていた情報で起動し、手元のデータを表示する
    const cached = readLocal<{ user: Me; workspaces: WorkspaceSummary[] } | null>(SESSION_CACHE, null);
    if (e instanceof ApiError && e.status === 0 && cached) {
      useSession.setState({ status: "authed", user: cached.user, workspaces: cached.workspaces });
      return cached;
    }
    throw e;
  }
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
  writeLocal(SESSION_CACHE, null);
  if (DEMO) {
    setBearerToken(null);
    writeLocal("sen:demo-token", null);
    writeLocal("sen:demo-logged-out", true);
  }
  useSession.setState({ status: "anon", user: null, workspaces: [] });
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
