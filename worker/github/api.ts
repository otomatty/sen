// GitHub REST API。fetch だけを使う。トークンはログにもエラー文言にも出さない。

import type { GitHubConfig } from "./config";

const API_VERSION = "2022-11-28";

export class GitHubError extends Error {
  status: number;
  /** 利用制限が明ける時刻（UNIX ミリ秒）。それ以外は null */
  rateLimitReset: number | null;
  constructor(status: number, message: string, rateLimitReset: number | null = null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.rateLimitReset = rateLimitReset;
  }
}

export interface GhUser {
  login: string;
}

export interface GhRepo {
  id: number;
  full_name: string;
  has_issues: boolean;
}

export interface GhLabel {
  name: string;
}

export interface GhIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "reopened" | "duplicate" | null;
  html_url: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  pull_request?: unknown;
  created_at: string;
  updated_at: string;
  user?: { login: string } | null;
}

export interface GhComment {
  id: number;
  body: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  /** 一覧 API が返す。Issue の番号を取り出す */
  issue_url?: string;
}

export interface GhHook {
  id: number;
}

export interface GhIssueWrite {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | "duplicate";
  labels?: string[];
  assignees?: string[];
}

export function getUser(cfg: GitHubConfig): Promise<GhUser> {
  return request(cfg, "GET", "/user");
}

export function getRepo(cfg: GitHubConfig, owner: string, repo: string): Promise<GhRepo> {
  return request(cfg, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

export function listLabels(cfg: GitHubConfig, owner: string, repo: string): Promise<GhLabel[]> {
  return paginate(cfg, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`);
}

export function createHook(
  cfg: GitHubConfig,
  owner: string,
  repo: string,
  hook: { url: string; secret: string; events: string[] },
): Promise<GhHook> {
  return request(cfg, "POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`, {
    name: "web",
    active: true,
    events: hook.events,
    config: {
      url: hook.url,
      content_type: "json",
      secret: hook.secret,
      insecure_ssl: "0",
    },
  });
}

export function deleteHook(cfg: GitHubConfig, owner: string, repo: string, hookId: number): Promise<void> {
  return request(cfg, "DELETE", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hookId}`);
}

export function getIssue(cfg: GitHubConfig, owner: string, repo: string, number: number): Promise<GhIssue> {
  return request(cfg, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`);
}

export function createIssue(cfg: GitHubConfig, owner: string, repo: string, issue: GhIssueWrite): Promise<GhIssue> {
  return request(cfg, "POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, issue);
}

export function updateIssue(cfg: GitHubConfig, owner: string, repo: string, number: number, patch: GhIssueWrite): Promise<GhIssue> {
  return request(cfg, "PATCH", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, patch);
}

export function listIssues(cfg: GitHubConfig, owner: string, repo: string, since: string): Promise<GhIssue[]> {
  const q = `state=all&since=${encodeURIComponent(since)}`;
  return paginate(cfg, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${q}`);
}

/** トークンの持ち主が作った Issue。since 以降をページごと */
export function listIssuesByCreator(cfg: GitHubConfig, owner: string, repo: string, since: string, creator: string): Promise<GhIssue[]> {
  const q = `state=all&since=${encodeURIComponent(since)}&creator=${encodeURIComponent(creator)}`;
  return paginate(cfg, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${q}`);
}

export function createComment(cfg: GitHubConfig, owner: string, repo: string, number: number, body: string): Promise<GhComment> {
  return request(cfg, "POST", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`, { body });
}

export function listComments(cfg: GitHubConfig, owner: string, repo: string, since: string): Promise<GhComment[]> {
  return paginate(
    cfg,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments?since=${encodeURIComponent(since)}`,
  );
}

/** 1 つの Issue のコメント。since 以降をページごと */
export function listIssueComments(cfg: GitHubConfig, owner: string, repo: string, number: number, since: string): Promise<GhComment[]> {
  return paginate(
    cfg,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?since=${encodeURIComponent(since)}`,
  );
}

export interface GhPull {
  number: number;
  title?: string | null;
  body?: string | null;
  html_url?: string | null;
  state?: string | null;
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  user?: { login?: string | null } | null;
  head?: { ref?: string | null } | null;
  updated_at?: string;
}

/** 更新が新しい順。since より前の行に達したら、そこから先は取りに行かない */
export async function listPullsSince(cfg: GitHubConfig, owner: string, repo: string, sinceIso: string): Promise<GhPull[]> {
  const since = Date.parse(sinceIso);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&sort=updated&direction=desc`;
  const out: GhPull[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await request<GhPull[]>(cfg, "GET", `${base}&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    let stop = false;
    for (const pull of batch) {
      if (!pull || typeof pull !== "object") continue;
      const updated = Date.parse(pull.updated_at ?? "");
      if (Number.isFinite(since) && Number.isFinite(updated) && updated < since) {
        stop = true;
        break;
      }
      out.push(pull);
    }
    if (stop || batch.length < 100) break;
  }
  return out;
}

async function paginate<T>(cfg: GitHubConfig, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 30; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await request<T[]>(cfg, "GET", `${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function request<T>(cfg: GitHubConfig, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.apiOrigin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "sen",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GitHubError(0, "GitHub に接続できませんでした");
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new GitHubError(res.status, "GitHub の応答を読み取れませんでした");
  }
}

async function toError(res: Response): Promise<GitHubError> {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetHeader = res.headers.get("x-ratelimit-reset");
  const resetSec = Number(resetHeader);
  const resetMs = Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 : null;
  if ((res.status === 403 && remaining === "0") || res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const when = res.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0 ? Date.now() + retryAfter * 1000 : resetMs;
    return new GitHubError(res.status, "GitHub の利用制限に達しました", when);
  }
  // 本文は読まない。トークンや secret が混ざる余地を残さない
  try {
    await res.body?.cancel();
  } catch {
    // 読み捨てに失敗しても、分類したエラーは返す
  }
  return new GitHubError(res.status, messageFor(res.status), null);
}

function messageFor(status: number): string {
  switch (status) {
    case 401:
      return "GitHub のトークンが無効です";
    case 403:
      return "GitHub の権限がありません";
    case 404:
      return "GitHub で見つかりませんでした";
    case 410:
      return "GitHub 側で削除されています";
    case 422:
      return "GitHub が変更を受け付けませんでした";
    default:
      return status >= 500 ? "GitHub が一時的に応答しません" : "GitHub への要求に失敗しました";
  }
}
