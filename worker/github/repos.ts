// リポジトリの連携・解除と、設定画面向けの状態。
// 変更は同期ログに流す。トークンと secret は保存しない（hook は auto / manual だけ）。

import type { GitHubRepo, GitHubRepoPatch, GitHubStatus, Role } from "../../shared/types";
import { all, first, run } from "../db";
import type { Env, WorkspaceRow } from "../env";
import { MutationError } from "../mutations";
import { loadEntity, notifyRealtime, writeChanges } from "../sync";
import { GitHubError, createHook, deleteHook, getRepo } from "./api";
import { githubConfig, githubRealtime, githubWebhookUrl, isGitHubTarget } from "./config";

const HOOK_EVENTS = ["issues", "issue_comment", "pull_request"];
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface RepoRow {
  team_id: string;
  workspace_id: string;
  repo_id: number;
  full_name: string;
  hook_id: number | null;
  pr_draft_state_id: string | null;
  pr_open_state_id: string | null;
  pr_merged_state_id: string | null;
}

export async function readGitHubStatus(env: Env, ws: WorkspaceRow, origin: string): Promise<GitHubStatus> {
  if (!isGitHubTarget(env, ws.url_key)) return { enabled: false, login: null, error: null, webhookUrl: "" };
  const webhookUrl = githubWebhookUrl(origin);
  try {
    const res = await githubRealtime(env, ws.id, "/github/status");
    if (!res.ok) return { enabled: true, login: null, error: "GitHub の状態を読み取れませんでした", webhookUrl };
    const body = (await res.json()) as { login?: unknown; error?: unknown };
    return {
      enabled: true,
      login: typeof body.login === "string" ? body.login : null,
      error: typeof body.error === "string" ? body.error : null,
      webhookUrl,
    };
  } catch (e) {
    console.error("github status failed", e instanceof Error ? e.name : "error");
    return { enabled: true, login: null, error: "GitHub の状態を読み取れませんでした", webhookUrl };
  }
}

export async function linkGitHubRepo(
  env: Env,
  ws: WorkspaceRow,
  userId: string,
  role: Role,
  origin: string,
  body: { teamId?: unknown; repo?: unknown },
): Promise<GitHubRepo> {
  assertAdmin(role);
  const cfg = requireTarget(env, ws);
  const teamId = typeof body.teamId === "string" ? body.teamId : "";
  const repoName = typeof body.repo === "string" ? body.repo.trim() : "";
  if (!REPO_NAME.test(repoName) || repoName.length > 200) fail("リポジトリは owner/name の形で指定してください");
  const team = await first<{ id: string }>(env.DB, "SELECT id FROM teams WHERE id = ? AND workspace_id = ?", teamId, ws.id);
  if (!team) fail("チームが見つかりません", 404);
  const already = await first(env.DB, "SELECT team_id FROM github_repos WHERE team_id = ?", teamId);
  if (already) fail("このチームはすでに GitHub のリポジトリと連携しています", 409);

  const slash = repoName.indexOf("/");
  const owner = repoName.slice(0, slash);
  const name = repoName.slice(slash + 1);
  let remote: { id: number; full_name: string; has_issues: boolean };
  try {
    remote = await getRepo(cfg, owner, name);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    await noteFailure(env, ws.id, e);
    throw repoLookupError(e);
  }
  await noteClear(env, ws.id);
  if (!Number.isSafeInteger(remote.id)) fail("リポジトリの情報を読み取れませんでした", 502);
  if (remote.has_issues === false) fail("このリポジトリでは Issues が無効です");
  const fullName = typeof remote.full_name === "string" && remote.full_name.includes("/") ? remote.full_name : repoName;
  const dup = await first<{ team_id: string }>(
    env.DB,
    "SELECT team_id FROM github_repos WHERE repo_id = ? OR lower(full_name) = lower(?)",
    remote.id,
    fullName,
  );
  if (dup) fail("このリポジトリは、ほかのチームですでに連携しています", 409);

  const defaults = await defaultPrStateIds(env.DB, teamId);
  const parts = splitFullName(fullName) ?? { owner, repo: name };
  let hookId: number | null = null;
  try {
    const hook = await createHook(cfg, parts.owner, parts.repo, {
      url: githubWebhookUrl(origin),
      secret: cfg.webhookSecret,
      events: HOOK_EVENTS,
    });
    if (typeof hook?.id === "number") hookId = hook.id;
  } catch (e) {
    if (e instanceof GitHubError) {
      console.error("github hook create failed", e.status);
      await noteFailure(env, ws.id, e);
    } else {
      console.error("github hook create failed", e instanceof Error ? e.name : "error");
    }
  }

  const now = Date.now();
  await run(
    env.DB,
    `INSERT INTO github_repos (
       team_id, workspace_id, repo_id, full_name, linked_by, linked_at, hook_id,
       pr_draft_state_id, pr_open_state_id, pr_merged_state_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    teamId,
    ws.id,
    remote.id,
    fullName,
    userId,
    now,
    hookId,
    defaults.draft,
    defaults.open,
    defaults.merged,
    now,
    now,
  );
  return publishRepo(env, ws.id, teamId);
}

export async function updateGitHubRepo(env: Env, ws: WorkspaceRow, role: Role, teamId: string, patch: GitHubRepoPatch): Promise<GitHubRepo> {
  assertAdmin(role);
  requireTarget(env, ws);
  const row = await repoRow(env.DB, ws.id, teamId);
  const draft = await assertState(env.DB, teamId, patch.prDraftStateId);
  const open = await assertState(env.DB, teamId, patch.prOpenStateId);
  const merged = await assertState(env.DB, teamId, patch.prMergedStateId);
  await run(
    env.DB,
    `UPDATE github_repos
     SET pr_draft_state_id = ?, pr_open_state_id = ?, pr_merged_state_id = ?, updated_at = ?
     WHERE team_id = ?`,
    draft === undefined ? row.pr_draft_state_id : draft,
    open === undefined ? row.pr_open_state_id : open,
    merged === undefined ? row.pr_merged_state_id : merged,
    Date.now(),
    teamId,
  );
  return publishRepo(env, ws.id, teamId);
}

export async function unlinkGitHubRepo(env: Env, ws: WorkspaceRow, role: Role, teamId: string): Promise<void> {
  assertAdmin(role);
  const cfg = requireTarget(env, ws);
  const row = await repoRow(env.DB, ws.id, teamId);
  const parts = splitFullName(row.full_name);
  if (row.hook_id != null && parts) {
    try {
      await deleteHook(cfg, parts.owner, parts.repo, row.hook_id);
    } catch (e) {
      console.error("github hook delete failed", e instanceof GitHubError ? e.status : e instanceof Error ? e.name : "error");
    }
  }
  const links = await all<{ issue_id: string }>(
    env.DB,
    "SELECT issue_id FROM github_issue_links WHERE workspace_id = ? AND repo_id = ?",
    ws.id,
    row.repo_id,
  );
  const pulls = await all<{ id: string }>(
    env.DB,
    "SELECT id FROM github_pull_links WHERE workspace_id = ? AND repo_id = ?",
    ws.id,
    row.repo_id,
  );
  await run(env.DB, "DELETE FROM github_issue_links WHERE workspace_id = ? AND repo_id = ?", ws.id, row.repo_id);
  await run(env.DB, "DELETE FROM github_pull_links WHERE workspace_id = ? AND repo_id = ?", ws.id, row.repo_id);
  await run(env.DB, "DELETE FROM github_repos WHERE team_id = ? AND workspace_id = ?", teamId, ws.id);
  const last = await writeChanges(env.DB, ws.id, [
    { entity: "githubRepo", entityId: teamId, op: "delete" },
    ...links.map((link) => ({ entity: "githubLink" as const, entityId: link.issue_id, op: "delete" as const })),
    ...pulls.map((pull) => ({ entity: "githubPull" as const, entityId: pull.id, op: "delete" as const })),
  ]);
  await notifyRealtime(env, ws.id, last);
}

/** 下書き → 進行中の最初、レビュー待ち → 「レビュー中」か進行中の最初、マージ → 完了の最初 */
export async function defaultPrStateIds(db: D1Database, teamId: string): Promise<{ draft: string | null; open: string | null; merged: string | null }> {
  const states = await all<{ id: string; name: string; type: string; position: number }>(
    db,
    "SELECT id, name, type, position FROM workflow_states WHERE team_id = ? ORDER BY position",
    teamId,
  );
  const started = states.filter((state) => state.type === "started");
  const review = states.find((state) => state.name === "レビュー中") ?? started[0] ?? null;
  const completed = states.find((state) => state.type === "completed") ?? null;
  return {
    draft: started[0]?.id ?? null,
    open: review?.id ?? null,
    merged: completed?.id ?? null,
  };
}

async function publishRepo(env: Env, workspaceId: string, teamId: string): Promise<GitHubRepo> {
  const last = await writeChanges(env.DB, workspaceId, [{ entity: "githubRepo", entityId: teamId, op: "upsert" }]);
  await notifyRealtime(env, workspaceId, last);
  const data = await loadEntity(env.DB, workspaceId, "githubRepo", teamId);
  if (!data) fail("保存に失敗しました", 500);
  return data as GitHubRepo;
}

async function repoRow(db: D1Database, workspaceId: string, teamId: string): Promise<RepoRow> {
  const row = await first<RepoRow>(db, "SELECT * FROM github_repos WHERE team_id = ? AND workspace_id = ?", teamId, workspaceId);
  if (!row) fail("このチームは GitHub と連携していません", 404);
  return row;
}

/** undefined は変更しない。null は「変えない」 */
async function assertState(db: D1Database, teamId: string, id: string | null | undefined): Promise<string | null | undefined> {
  if (id === undefined) return undefined;
  if (id === null || id === "") return null;
  if (typeof id !== "string") fail("ステータスが不正です");
  const row = await first(db, "SELECT id FROM workflow_states WHERE id = ? AND team_id = ?", id, teamId);
  if (!row) fail("ステータスが見つかりません", 404);
  return id;
}

function requireTarget(env: Env, ws: WorkspaceRow) {
  const cfg = githubConfig(env);
  if (!cfg || cfg.workspaceKey !== ws.url_key) fail("このワークスペースでは GitHub 連携が設定されていません", 404);
  return cfg;
}

function assertAdmin(role: Role) {
  if (role !== "admin") fail("この操作には管理者権限が必要です", 403);
}

function fail(message: string, status = 400): never {
  throw new MutationError(message, status);
}

function repoLookupError(e: GitHubError): MutationError {
  if (e.rateLimitReset != null || e.status === 429) return new MutationError(e.message, 429);
  if (e.status === 404) return new MutationError("リポジトリが見つかりません", 404);
  if (e.status === 401) return new MutationError(e.message, 401);
  if (e.status === 403) return new MutationError("このリポジトリを見る権限がありません", 403);
  return new MutationError(e.message, 502);
}

function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const i = fullName.indexOf("/");
  if (i <= 0 || i !== fullName.lastIndexOf("/") || i === fullName.length - 1) return null;
  return { owner: fullName.slice(0, i), repo: fullName.slice(i + 1) };
}

async function noteFailure(env: Env, workspaceId: string, e: GitHubError): Promise<void> {
  if (e.status !== 401 && e.status !== 429 && e.rateLimitReset == null) return;
  await postNote(env, workspaceId, { error: e.message, rateLimitReset: e.rateLimitReset });
}

async function noteClear(env: Env, workspaceId: string): Promise<void> {
  await postNote(env, workspaceId, { error: null, rateLimitReset: null });
}

async function postNote(env: Env, workspaceId: string, body: { error: string | null; rateLimitReset: number | null }): Promise<void> {
  try {
    await githubRealtime(env, workspaceId, "/github/note", body);
  } catch (e) {
    console.error("github note failed", e instanceof Error ? e.name : "error");
  }
}
