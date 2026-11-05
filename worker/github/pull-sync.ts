// プルリクエストの紐づけと、ステータスの前への移動。参照の取り出しは pulls.ts。

import type { GitHubPullState, Mutation, StateType } from "../../shared/types";
import { all, ensureMigrated, first, run } from "../db";
import type { Env } from "../env";
import type { Change } from "../sync";
import { loadWorkspace, resolveGitHubActor } from "./actor";
import { applyGitHubChanges, commitGitHubChanges } from "./apply";
import type { GitHubPullEvent } from "./events";
import { advanceStateId, type WorkflowStateRef } from "./merge";
import { extractPullReferences, pullLinkState } from "./pulls";

export interface PullSyncCtx {
  env: Env;
  workspaceId: string;
  enqueueIssue: (issueId: string) => Promise<void>;
  scheduleSheets?: () => Promise<void>;
}

interface RepoSettings {
  team_id: string;
  repo_id: number;
  full_name: string;
  linked_by: string;
  pr_draft_state_id: string | null;
  pr_open_state_id: string | null;
  pr_merged_state_id: string | null;
}

interface PullRow {
  id: string;
  issue_id: string;
  repo: string;
  title: string;
  url: string;
  state: string;
  author: string | null;
}

/** 処理の前に、この PR と紐づく課題のロックを取る */
export async function pullLockKeys(db: D1Database, workspaceId: string, payload: unknown): Promise<string[]> {
  const event = asPull(payload);
  if (!event) return [];
  const keys = [`pull:${event.repository.id}:${event.pull_request.number}`];
  const issueIds = new Set(await resolveIssueIds(db, workspaceId, event));
  const existing = await all<{ issue_id: string }>(
    db,
    "SELECT issue_id FROM github_pull_links WHERE workspace_id = ? AND repo_id = ? AND number = ?",
    workspaceId,
    event.repository.id,
    event.pull_request.number,
  );
  for (const row of existing) issueIds.add(row.issue_id);
  for (const id of issueIds) keys.push(`issue:${id}`);
  return keys;
}

export async function syncPull(ctx: PullSyncCtx, payload: GitHubPullEvent | null | undefined): Promise<void> {
  const event = asPull(payload);
  if (!event) return;
  await ensureMigrated(ctx.env.DB);
  const ws = await loadWorkspace(ctx.env.DB, ctx.workspaceId);
  if (!ws) return;
  const repo = await first<RepoSettings>(
    ctx.env.DB,
    "SELECT team_id, repo_id, full_name, linked_by, pr_draft_state_id, pr_open_state_id, pr_merged_state_id FROM github_repos WHERE workspace_id = ? AND repo_id = ?",
    ctx.workspaceId,
    event.repository.id,
  );
  if (!repo) return;

  const state = pullLinkState(event.pull_request);
  const author = event.pull_request.user?.login?.trim() || null;
  const url = event.pull_request.html_url || `https://github.com/${repo.full_name}/pull/${event.pull_request.number}`;
  const title = event.pull_request.title ?? "";
  const issueIds = await resolveIssueIds(ctx.env.DB, ctx.workspaceId, event);
  await rewritePullLinks(ctx, ws, {
    repoId: repo.repo_id,
    repo: repo.full_name,
    number: event.pull_request.number,
    title,
    url,
    state,
    author,
    issueIds,
  });

  const actorHolder: { current?: Awaited<ReturnType<typeof resolveGitHubActor>> } = {};
  for (const issueId of issueIds) {
    const moved = await advanceIssue(ctx, ws, repo.linked_by, author, issueId, state, actorHolder);
    if (moved === "completed" || moved === "canceled") await ctx.enqueueIssue(issueId);
  }
}

function asPull(payload: unknown): GitHubPullEvent | null {
  const event = payload as Partial<GitHubPullEvent> | null;
  const number = event?.pull_request?.number;
  const repoId = event?.repository?.id;
  if (!event?.pull_request || !event.repository) return null;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return null;
  if (typeof repoId !== "number" || !Number.isSafeInteger(repoId)) return null;
  return event as GitHubPullEvent;
}

async function resolveIssueIds(db: D1Database, workspaceId: string, event: GitHubPullEvent): Promise<string[]> {
  const teams = await all<{ key: string }>(db, "SELECT key FROM teams WHERE workspace_id = ?", workspaceId);
  const repo = await first<{ repo_id: number }>(
    db,
    "SELECT repo_id FROM github_repos WHERE workspace_id = ? AND repo_id = ?",
    workspaceId,
    event.repository.id,
  );
  const extracted = extractPullReferences(
    {
      branch: event.pull_request.head?.ref ?? "",
      title: event.pull_request.title ?? "",
      body: event.pull_request.body ?? "",
    },
    teams.map((team) => team.key),
  );
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | null) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const ref of extracted.issues) add(await issueIdByKey(db, workspaceId, ref.key, ref.number));
  for (const ref of extracted.github) {
    const repoId = ref.repo ? await linkedRepoId(db, workspaceId, ref.repo) : (repo?.repo_id ?? null);
    if (repoId == null) continue;
    add(await issueIdByGitHub(db, workspaceId, repoId, ref.number));
  }
  return ids;
}

async function rewritePullLinks(
  ctx: PullSyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  pull: { repoId: number; repo: string; number: number; title: string; url: string; state: GitHubPullState; author: string | null; issueIds: string[] },
): Promise<void> {
  const existing = await all<PullRow>(
    ctx.env.DB,
    "SELECT id, issue_id, repo, title, url, state, author FROM github_pull_links WHERE workspace_id = ? AND repo_id = ? AND number = ?",
    ctx.workspaceId,
    pull.repoId,
    pull.number,
  );
  const byIssue = new Map(existing.map((row) => [row.issue_id, row]));
  const keep = new Set(pull.issueIds);
  const changes: Change[] = [];
  const now = Date.now();
  for (const issueId of pull.issueIds) {
    const row = byIssue.get(issueId);
    if (!row) {
      const id = crypto.randomUUID();
      await run(
        ctx.env.DB,
        `INSERT INTO github_pull_links (
           id, workspace_id, issue_id, repo_id, repo, number, title, url, state, author, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        ctx.workspaceId,
        issueId,
        pull.repoId,
        pull.repo,
        pull.number,
        pull.title,
        pull.url,
        pull.state,
        pull.author,
        now,
      );
      changes.push({ entity: "githubPull", entityId: id, op: "upsert" });
      continue;
    }
    if (row.repo === pull.repo && row.title === pull.title && row.url === pull.url && row.state === pull.state && row.author === pull.author) continue;
    await run(
      ctx.env.DB,
      "UPDATE github_pull_links SET repo = ?, title = ?, url = ?, state = ?, author = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      pull.repo,
      pull.title,
      pull.url,
      pull.state,
      pull.author,
      now,
      row.id,
      ctx.workspaceId,
    );
    changes.push({ entity: "githubPull", entityId: row.id, op: "upsert" });
  }
  for (const row of existing) {
    if (keep.has(row.issue_id)) continue;
    await run(ctx.env.DB, "DELETE FROM github_pull_links WHERE id = ? AND workspace_id = ?", row.id, ctx.workspaceId);
    changes.push({ entity: "githubPull", entityId: row.id, op: "delete" });
  }
  await commitGitHubChanges(ctx.env, ws, changes, ctx.scheduleSheets);
}

/** 動かしたとき、移動先の種類を返す。動かさなければ null */
async function advanceIssue(
  ctx: PullSyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  linkedBy: string,
  author: string | null,
  issueId: string,
  pullState: GitHubPullState,
  actorHolder: { current?: Awaited<ReturnType<typeof resolveGitHubActor>> },
): Promise<StateType | null> {
  const targetId = targetFor(pullState);
  if (targetId === "skip") return null;
  const issue = await first<{ id: string; team_id: string; state_id: string }>(
    ctx.env.DB,
    "SELECT id, team_id, state_id FROM issues WHERE id = ? AND workspace_id = ?",
    issueId,
    ctx.workspaceId,
  );
  if (!issue) return null;
  const settings = await first<Pick<RepoSettings, "pr_draft_state_id" | "pr_open_state_id" | "pr_merged_state_id">>(
    ctx.env.DB,
    "SELECT pr_draft_state_id, pr_open_state_id, pr_merged_state_id FROM github_repos WHERE workspace_id = ? AND team_id = ?",
    ctx.workspaceId,
    issue.team_id,
  );
  if (!settings) return null;
  const configured = targetId(settings);
  const states = await all<WorkflowStateRef>(
    ctx.env.DB,
    "SELECT id, name, type, position FROM workflow_states WHERE team_id = ? ORDER BY position",
    issue.team_id,
  );
  const next = advanceStateId(states, issue.state_id, configured);
  if (!next) return null;
  const target = states.find((state) => state.id === next);
  if (!target) return null;
  if (!actorHolder.current) actorHolder.current = await resolveGitHubActor(ctx.env.DB, ctx.workspaceId, linkedBy, author);
  const mutation: Mutation = { type: "issue.update", args: { id: issue.id, patch: { stateId: next } } };
  await applyGitHubChanges({
    env: ctx.env,
    ws,
    actor: actorHolder.current,
    via: "GitHub",
    scheduleSheets: ctx.scheduleSheets,
    mutations: [mutation],
  });
  return target.type;
}

function targetFor(state: GitHubPullState): ((settings: Pick<RepoSettings, "pr_draft_state_id" | "pr_open_state_id" | "pr_merged_state_id">) => string | null) | "skip" {
  if (state === "draft") return (settings) => settings.pr_draft_state_id || null;
  if (state === "open") return (settings) => settings.pr_open_state_id || null;
  if (state === "merged") return (settings) => settings.pr_merged_state_id || null;
  return "skip";
}

async function issueIdByKey(db: D1Database, workspaceId: string, key: string, number: number): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    `SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id
     WHERE i.workspace_id = ? AND t.key = ? AND i.number = ?`,
    workspaceId,
    key,
    number,
  );
  return row?.id ?? null;
}

async function issueIdByGitHub(db: D1Database, workspaceId: string, repoId: number, number: number): Promise<string | null> {
  const row = await first<{ issue_id: string }>(
    db,
    "SELECT issue_id FROM github_issue_links WHERE workspace_id = ? AND repo_id = ? AND number = ?",
    workspaceId,
    repoId,
    number,
  );
  return row?.issue_id ?? null;
}

async function linkedRepoId(db: D1Database, workspaceId: string, fullName: string): Promise<number | null> {
  const row = await first<{ repo_id: number }>(
    db,
    "SELECT repo_id FROM github_repos WHERE workspace_id = ? AND lower(full_name) = lower(?)",
    workspaceId,
    fullName,
  );
  return row?.repo_id ?? null;
}

