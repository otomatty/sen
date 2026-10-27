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
    const res = await api<{ user: Me | null; workspaces: WorkspaceSummary[] }>("/api/auth/me");
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

export async function login(email: string, password: string): Promise<string | null> {
  const res = await api<{ workspaceKey: string | null; token?: string }>("/api/auth/login", { body: { email, password } });
  rememberToken(res.token);
  await loadSession();
  return res.workspaceKey;
}

export async function signup(input: { name: string; email: string; password: string; workspaceName?: string; inviteCode?: string }) {
  const res = await api<{ workspaceKey: string; token?: string }>("/api/auth/signup", { body: input });
  rememberToken(res.token);
  await loadSession();
  return res.workspaceKey;
}

export async function logout() {
  try {
    await api("/api/auth/logout", { body: {} });
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
    useSession.setState({ status: "anon", user: null, workspaces: [] });
    return;
  }
  useSession.setState({ status: "anon", user: null, workspaces: [] });
  window.location.assign("/login");
}

export function lastWorkspaceKey(): string | null {
  return readLocal<string | null>("sen:last-ws", null);
}
export function setLastWorkspaceKey(key: string) {
  writeLocal("sen:last-ws", key);
}
