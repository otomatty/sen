// 課題とコメントの突き合わせ。Webhook の中身は使わず、いつも GitHub の最新を取り直す。

import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import { isMarkdownBlank } from "../../shared/markdown";
import type { IssuePatch, Me, Mutation, Role, StateType } from "../../shared/types";
import { all, ensureMigrated, first, run } from "../db";
import type { Env } from "../env";
import { MutationError } from "../mutations";
import { actorById, loadWorkspace, resolveGitHubActor } from "./actor";
import { applyGitHubChanges, commitGitHubChanges, type GitHubActivityData, type GitHubWrite } from "./apply";
import {
  GitHubError,
  createComment,
  createIssue,
  getIssue,
  listComments,
  listIssues,
  listLabels,
  listPullsSince,
  updateIssue,
  type GhIssue,
  type GhIssueWrite,
  type GhLabel,
} from "./api";
import { githubConfig } from "./config";
import type { GitHubCommentEvent, GitHubPullEvent } from "./events";
import { pullLockKeys } from "./pull-sync";
import { toPullEvent } from "./pulls";
import {
  BODY_CONFLICT_NOTE,
  formatOutboundComment,
  githubStateWrite,
  githubSyncState,
  initialStateId,
  isOwnGitHubComment,
  issueNumberFromComment,
  mergeLabels,
  mergeOpenClosed,
  mergeScalar,
  nextGitHubAssignees,
  parseIssueRef,
  resolveGitHubAssignee,
  sameNameSet,
  sameRepo,
  senSyncState,
  splitFullName,
  stateIdForGitHub,
  syncStateParts,
  type MergeAction,
  type SyncState,
  type WorkflowStateRef,
} from "./merge";

export interface SyncCtx {
  env: Env;
  workspaceId: string;
  labelCache: Map<string, GhLabel[]>;
  enqueueComment: (commentId: string) => Promise<void>;
  scheduleSheets?: () => Promise<void>;
}

export interface IssueOp {
  workspaceId: string;
  userId: string;
  issueId: string;
  action: "create" | "link" | "unlink";
  ref?: string;
  prefer?: "sen" | "github";
}

interface RepoRow {
  team_id: string;
  repo_id: number;
  full_name: string;
  linked_by: string;
  linked_at: number;
}

interface LinkRow {
  issue_id: string;
  repo_id: number;
  number: number;
  url: string;
  base_title: string;
  base_body: string;
  base_state: string;
  base_labels: string;
  base_assignee: string | null;
  last_error: string | null;
}

interface IssueRow {
  id: string;
  team_id: string;
  title: string;
  description: string;
  state_id: string;
  assignee_id: string | null;
  label_ids: string;
  created_at: number;
  archived_at: number | null;
  state_type: StateType;
  state_name: string;
}

interface LabelRow {
  id: string;
  name: string;
}

const ASSIGNEE_ERROR = /^担当者を GitHub に反映できませんでした（(.+)）$/;

export async function reconcileIssue(
  ctx: SyncCtx,
  target: { issueId: string } | { repoId: number; number: number },
  opts: { actor?: { user: Me; role: Role }; via?: string | null; force?: boolean; senderLogin?: string | null } = {},
): Promise<void> {
  await ensureMigrated(ctx.env.DB);
  const ws = await loadWorkspace(ctx.env.DB, ctx.workspaceId);
  if (!ws) return;
  if ("issueId" in target) {
    const issue = await loadIssue(ctx.env.DB, ctx.workspaceId, target.issueId);
    if (!issue) return;
    const link = await linkByIssue(ctx.env.DB, ctx.workspaceId, issue.id);
    if (link) {
      const repo = await repoById(ctx.env.DB, ctx.workspaceId, link.repo_id);
      if (!repo) return;
      await reconcileLinked(ctx, ws, repo, link, issue, opts);
      return;
    }
    if (issue.archived_at) return;
    const repo = await repoByTeam(ctx.env.DB, ctx.workspaceId, issue.team_id);
    if (!repo) return;
    if (!opts.force && issue.created_at < repo.linked_at) return;
    if (!opts.force && (await createdViaGitHub(ctx.env.DB, issue.id))) return;
    await createFromSen(ctx, ws, repo, issue, opts);
    return;
  }
  const repo = await repoById(ctx.env.DB, ctx.workspaceId, target.repoId);
  if (!repo) return;
  const link = await linkByNumber(ctx.env.DB, ctx.workspaceId, target.repoId, target.number);
  if (link) {
    const issue = await loadIssue(ctx.env.DB, ctx.workspaceId, link.issue_id);
    if (!issue) {
      await deleteLink(ctx, ws, link.issue_id);
      return;
    }
    await reconcileLinked(ctx, ws, repo, link, issue, opts);
    return;
  }
  await importIfNew(ctx, ws, repo, target.number, opts);
}

export async function pushComment(ctx: SyncCtx, commentId: string): Promise<void> {
  await ensureMigrated(ctx.env.DB);
  const comment = await first<{
    id: string;
    issue_id: string;
    user_id: string;
    body: string;
    edited_at: number | null;
    github_author: string | null;
  }>(ctx.env.DB, "SELECT id, issue_id, user_id, body, edited_at, github_author FROM comments WHERE id = ? AND workspace_id = ?", commentId, ctx.workspaceId);
  if (!comment || comment.edited_at != null || comment.github_author) return;
  const known = await first(ctx.env.DB, "SELECT comment_id FROM github_comment_links WHERE comment_id = ?", comment.id);
  if (known) return;
  const link = await linkByIssue(ctx.env.DB, ctx.workspaceId, comment.issue_id);
  if (!link) return;
  const repo = await repoById(ctx.env.DB, ctx.workspaceId, link.repo_id);
  const parts = repo ? splitFullName(repo.full_name) : null;
  const cfg = githubConfig(ctx.env);
  if (!repo || !parts || !cfg) return;
  const user = await first<{ name: string }>(ctx.env.DB, "SELECT name FROM users WHERE id = ?", comment.user_id);
  const created = await createComment(cfg, parts.owner, parts.repo, link.number, formatOutboundComment(user?.name || "Sen", comment.body, comment.id));
  await run(
    ctx.env.DB,
    "INSERT INTO github_comment_links (comment_id, workspace_id, github_comment_id, created_at) VALUES (?, ?, ?, ?)",
    comment.id,
    ctx.workspaceId,
    created.id,
    Date.now(),
  );
}

export async function pullComment(ctx: SyncCtx, payload: GitHubCommentEvent | null | undefined): Promise<void> {
  if (!payload?.comment || !payload.issue || !payload.repository) return;
  const body = payload.comment.body ?? "";
  if (isOwnGitHubComment(body) || isMarkdownBlank(body)) return;
  await ensureMigrated(ctx.env.DB);
  const ws = await loadWorkspace(ctx.env.DB, ctx.workspaceId);
  if (!ws) return;
  const known = await first(ctx.env.DB, "SELECT comment_id FROM github_comment_links WHERE github_comment_id = ?", payload.comment.id);
  if (known) return;
  const repo = await repoById(ctx.env.DB, ctx.workspaceId, payload.repository.id);
  if (!repo) return;
  const link = await linkByNumber(ctx.env.DB, ctx.workspaceId, payload.repository.id, payload.issue.number);
  if (!link) return;
  const login = payload.comment.user?.login ?? payload.sender?.login ?? null;
  const actor = await resolveGitHubActor(ctx.env.DB, ctx.workspaceId, repo.linked_by, login);
  const member = login ? await memberHasLogin(ctx.env.DB, ctx.workspaceId, login) : false;
  const commentId = await commentUuid(payload.comment.id);
  const existing = await first(ctx.env.DB, "SELECT id FROM comments WHERE id = ?", commentId);
  if (!existing) {
    const createdAt = Date.parse(payload.comment.created_at);
    await applyGitHubChanges({
      env: ctx.env,
      ws,
      actor,
      via: "GitHub",
      now: Number.isFinite(createdAt) ? createdAt : Date.now(),
      githubComment: { author: member ? null : login },
      scheduleSheets: ctx.scheduleSheets,
      mutations: [{ type: "comment.create", args: { id: commentId, issueId: link.issue_id, body } }],
    });
  }
  await run(
    ctx.env.DB,
    "INSERT OR IGNORE INTO github_comment_links (comment_id, workspace_id, github_comment_id, created_at) VALUES (?, ?, ?, ?)",
    commentId,
    ctx.workspaceId,
    payload.comment.id,
    Date.now(),
  );
}

export async function runManual(ctx: SyncCtx, op: IssueOp): Promise<void> {
  await ensureMigrated(ctx.env.DB);
  const ws = await loadWorkspace(ctx.env.DB, op.workspaceId);
  if (!ws || ws.id !== ctx.workspaceId) fail("ワークスペースが見つかりません", 404);
  const actor = await actorById(ctx.env.DB, ctx.workspaceId, op.userId);
  if (!actor) fail("このワークスペースへのアクセス権がありません", 403);
  const issue = await loadIssue(ctx.env.DB, ctx.workspaceId, op.issueId);
  if (!issue) fail("課題が見つかりません", 404);
  const opts = { actor, via: null as string | null, force: true };
  if (op.action === "unlink") {
    const link = await linkByIssue(ctx.env.DB, ctx.workspaceId, issue.id);
    if (!link) fail("この課題は GitHub と紐づいていません", 404);
    const repo = await repoById(ctx.env.DB, ctx.workspaceId, link.repo_id);
    await unlink(ctx, ws, repo, link, opts);
    return;
  }
  if (issue.archived_at) fail("アーカイブされた課題は GitHub と紐づけられません");
  const existing = await linkByIssue(ctx.env.DB, ctx.workspaceId, issue.id);
  if (existing) fail("この課題はすでに GitHub の Issue と紐づいています", 409);
  const repo = await repoByTeam(ctx.env.DB, ctx.workspaceId, issue.team_id);
  if (!repo) fail("このチームは GitHub と連携していません", 404);
  if (op.action === "create") {
    await createFromSen(ctx, ws, repo, issue, opts);
    return;
  }
  const ref = parseIssueRef(op.ref ?? "", repo.full_name);
  if (!ref) fail("Issue は番号、owner/repo#番号、Issue の URL で指定してください");
  if (!sameRepo(ref.fullName, repo.full_name)) fail("連携していないリポジトリの Issue です");
  if (op.prefer !== "sen" && op.prefer !== "github") fail("どちらの内容に合わせるかを指定してください");
  const taken = await linkByNumber(ctx.env.DB, ctx.workspaceId, repo.repo_id, ref.number);
  if (taken) fail("この Issue は、別の課題とすでに紐づいています", 409);
  const cfg = requireConfig(ctx.env);
  const parts = splitFullName(repo.full_name);
  if (!parts) fail("リポジトリの名前が不正です");
  let remote: GhIssue;
  try {
    remote = await getIssue(cfg, parts.owner, parts.repo, ref.number);
  } catch (e) {
    rethrowGitHub(e);
  }
  if (remote.pull_request) fail("プルリクエストは課題と紐づけられません");
  const draft = await seededBase(ctx, cfg, repo, issue, remote, op.prefer);
  await insertLink(ctx.env.DB, ctx.workspaceId, draft);
  try {
    await writeGitHubActivity(ctx, ws, opts, issue.id, "linked", repo, draft.number, draft.url);
    await reconcileIssue(ctx, { issueId: issue.id }, opts);
  } catch (e) {
    await deleteLink(ctx, ws, issue.id);
    throw e;
  }
}

export async function scanUpdates(
  env: Env,
  workspaceId: string,
  storage: { get(key: string): Promise<string | undefined>; put(key: string, value: string): Promise<void> },
  enqueue: {
    issue(repoId: number, number: number): Promise<void>;
    comment(payload: GitHubCommentEvent): Promise<void>;
    pull(payload: GitHubPullEvent): Promise<void>;
  },
): Promise<void> {
  await ensureMigrated(env.DB);
  const cfg = githubConfig(env);
  if (!cfg) return;
  const repos = await all<RepoRow>(env.DB, "SELECT team_id, repo_id, full_name, linked_by, linked_at FROM github_repos WHERE workspace_id = ?", workspaceId);
  const nowIso = new Date().toISOString();
  for (const repo of repos) {
    const parts = splitFullName(repo.full_name);
    if (!parts) continue;
    const stored = await storage.get(sinceKey(repo.repo_id));
    const since = stored ? new Date(Date.parse(stored) - 2000).toISOString() : new Date(repo.linked_at).toISOString();
    const issues = await listIssues(cfg, parts.owner, parts.repo, since);
    for (const issue of issues) {
      if (!issue || issue.pull_request || !Number.isSafeInteger(issue.number)) continue;
      const link = await linkByNumber(env.DB, workspaceId, repo.repo_id, issue.number);
      const created = Date.parse(issue.created_at);
      if (link || (Number.isFinite(created) && created >= repo.linked_at)) await enqueue.issue(repo.repo_id, issue.number);
    }
    const comments = await listComments(cfg, parts.owner, parts.repo, since);
    for (const comment of comments) {
      if (!comment || !Number.isSafeInteger(comment.id) || isOwnGitHubComment(comment.body)) continue;
      const known = await first(env.DB, "SELECT comment_id FROM github_comment_links WHERE github_comment_id = ?", comment.id);
      if (known) continue;
      const number = issueNumberFromComment(comment.issue_url, comment.html_url);
      if (number == null) continue;
      await enqueue.comment({
        action: "created",
        comment: {
          id: comment.id,
          body: comment.body ?? "",
          html_url: comment.html_url ?? "",
          created_at: comment.created_at,
          user: comment.user?.login ? { login: comment.user.login } : null,
        },
        issue: { number },
        repository: { id: repo.repo_id, full_name: repo.full_name },
        sender: comment.user?.login ? { login: comment.user.login } : null,
      });
    }
    const pulls = await listPullsSince(cfg, parts.owner, parts.repo, since);
    for (const pull of pulls) {
      const payload = toPullEvent({ id: repo.repo_id, full_name: repo.full_name }, pull);
      if (payload) await enqueue.pull(payload);
    }
    await storage.put(sinceKey(repo.repo_id), nowIso);
  }
}

export async function lockKeysForJob(db: D1Database, workspaceId: string, key: string, payload: unknown): Promise<string[]> {
  const keys: string[] = [];
  if (key.startsWith("gh:dirty:issue:")) {
    const issueId = key.slice("gh:dirty:issue:".length);
    keys.push(`issue:${issueId}`);
    const link = await linkByIssue(db, workspaceId, issueId);
    if (link) keys.push(`gh:${link.repo_id}:${link.number}`, `create:${link.repo_id}`);
    else {
      const issue = await first<{ team_id: string }>(db, "SELECT team_id FROM issues WHERE id = ? AND workspace_id = ?", issueId, workspaceId);
      const repo = issue ? await repoByTeam(db, workspaceId, issue.team_id) : null;
      if (repo) keys.push(`create:${repo.repo_id}`);
    }
  } else if (key.startsWith("gh:dirty:gh:")) {
    const [repoId, number] = key.slice("gh:dirty:gh:".length).split(":");
    keys.push(`gh:${repoId}:${number}`, `create:${repoId}`);
    const link = await linkByNumber(db, workspaceId, Number(repoId), Number(number));
    if (link) keys.push(`issue:${link.issue_id}`);
  } else if (key.startsWith("gh:dirty:comment:")) {
    const row = await first<{ issue_id: string }>(db, "SELECT issue_id FROM comments WHERE id = ? AND workspace_id = ?", key.slice("gh:dirty:comment:".length), workspaceId);
    if (row) {
      keys.push(`issue:${row.issue_id}`);
      const link = await linkByIssue(db, workspaceId, row.issue_id);
      if (link) keys.push(`gh:${link.repo_id}:${link.number}`);
    }
  } else if (key.startsWith("gh:event:comment:")) {
    const event = payload as Partial<GitHubCommentEvent> | null;
    const repoId = event?.repository?.id;
    const number = event?.issue?.number;
    if (typeof repoId === "number" && typeof number === "number") {
      keys.push(`gh:${repoId}:${number}`);
      const link = await linkByNumber(db, workspaceId, repoId, number);
      if (link) keys.push(`issue:${link.issue_id}`);
    }
  } else if (key.startsWith("gh:event:pull:")) {
    keys.push(...(await pullLockKeys(db, workspaceId, payload)));
  }
  return keys;
}

export async function lockKeysForManual(db: D1Database, op: IssueOp): Promise<string[]> {
  const keys = [`issue:${op.issueId}`];
  const issue = await first<{ team_id: string }>(db, "SELECT team_id FROM issues WHERE id = ? AND workspace_id = ?", op.issueId, op.workspaceId);
  const link = await linkByIssue(db, op.workspaceId, op.issueId);
  if (link) keys.push(`gh:${link.repo_id}:${link.number}`, `create:${link.repo_id}`);
  const repo = issue ? await repoByTeam(db, op.workspaceId, issue.team_id) : null;
  if (repo) {
    keys.push(`create:${repo.repo_id}`);
    if (op.action === "link" && op.ref) {
      const parsed = parseIssueRef(op.ref, repo.full_name);
      if (parsed && sameRepo(parsed.fullName, repo.full_name)) keys.push(`gh:${repo.repo_id}:${parsed.number}`);
    }
  }
  return keys;
}

async function createFromSen(
  ctx: SyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  repo: RepoRow,
  issue: IssueRow,
  opts: { actor?: { user: Me; role: Role }; via?: string | null; force?: boolean },
): Promise<void> {
  const cfg = requireConfig(ctx.env);
  const parts = splitFullName(repo.full_name);
  if (!parts) return;
  const catalog = await loadLabels(ctx.env.DB, ctx.workspaceId);
  const repoLabels = await cachedLabels(ctx, cfg, repo.full_name);
  const common = commonNames(catalog, repoLabels);
  const currentIds = parseIds(issue.label_ids);
  const senNames = currentIds.map((id) => catalog.find((label) => label.id === id)?.name ?? "").filter(Boolean);
  const final = [...intersectNames(senNames, common)];
  const { byUser } = await loadLogins(ctx.env.DB, ctx.workspaceId);
  const senLogin = issue.assignee_id ? (byUser.get(issue.assignee_id) ?? null) : null;
  const write: GhIssueWrite = {
    title: issue.title,
    body: issue.description,
    labels: githubLabelList([], repoLabels, final, common),
  };
  if (senLogin) write.assignees = [senLogin];
  let remote: GhIssue;
  let rejected: string | null = null;
  try {
    remote = await createIssue(cfg, parts.owner, parts.repo, write);
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 422 || !write.assignees?.length) throw e;
    const { assignees: _assignees, ...rest } = write;
    remote = await createIssue(cfg, parts.owner, parts.repo, rest);
    rejected = senLogin;
  }
  const senState = senSyncState(issue.state_type, issue.state_name);
  if (senState !== "open") {
    try {
      const write = githubStateWrite(senState);
      remote = await updateIssue(cfg, parts.owner, parts.repo, remote.number, {
        state: write.state,
        state_reason: write.state_reason,
      });
    } catch (e) {
      await insertLink(ctx.env.DB, ctx.workspaceId, draftFrom(issue, repo, remote, final, rejected ? null : senLogin, rejected));
      throw e;
    }
  }
  const draft = draftFrom(issue, repo, remote, final, rejected ? null : senLogin, rejected);
  await insertLink(ctx.env.DB, ctx.workspaceId, draft);
  await publishLink(ctx, ws, issue.id);
  const actor = opts.actor ?? (await resolveGitHubActor(ctx.env.DB, ctx.workspaceId, repo.linked_by, null));
  await writeGitHubActivity(ctx, ws, { actor, via: opts.via }, issue.id, "created", repo, remote.number, draft.url);
}

async function importIfNew(
  ctx: SyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  repo: RepoRow,
  number: number,
  opts: { senderLogin?: string | null } = {},
): Promise<void> {
  const cfg = requireConfig(ctx.env);
  const parts = splitFullName(repo.full_name);
  if (!parts) return;
  let remote: GhIssue;
  try {
    remote = await getIssue(cfg, parts.owner, parts.repo, number);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
  if (remote.pull_request) return;
  const created = Date.parse(remote.created_at);
  if (!Number.isFinite(created) || created < repo.linked_at) return;
  const states = await loadStates(ctx.env.DB, repo.team_id);
  const imported = syncStateParts(githubSyncState(remote.state, remote.state_reason));
  const stateId = initialStateId(states, imported.openClosed, imported.reason);
  if (!stateId) return;
  const catalog = await loadLabels(ctx.env.DB, ctx.workspaceId);
  const repoLabels = await cachedLabels(ctx, cfg, repo.full_name);
  const common = commonNames(catalog, repoLabels);
  const ghNames = (remote.labels ?? []).map((label) => label.name);
  const final = mergeLabels([], [], ghNames, [...common]);
  const { byLogin } = await loadLogins(ctx.env.DB, ctx.workspaceId);
  const assigneeLogin = resolveGitHubAssignee(
    (remote.assignees ?? []).map((user) => user.login),
    null,
    new Set(byLogin.keys()),
  );
  const issueId = crypto.randomUUID();
  const actor = await resolveGitHubActor(ctx.env.DB, ctx.workspaceId, repo.linked_by, opts.senderLogin ?? null);
  const url = remote.html_url || `https://github.com/${repo.full_name}/issues/${remote.number}`;
  await applyGitHubChanges({
    env: ctx.env,
    ws,
    actor,
    scheduleSheets: ctx.scheduleSheets,
    mutations: [
      {
        type: "issue.create",
        args: {
          id: issueId,
          teamId: repo.team_id,
          title: remote.title,
          description: remote.body ?? "",
          stateId,
          assigneeId: assigneeLogin ? (byLogin.get(assigneeLogin) ?? null) : null,
          labelIds: senLabelIds([], catalog, final, common),
        },
      },
    ],
    activities: [{ issueId, data: { action: "imported", repo: repo.full_name, number: remote.number, url } }],
  });
  await insertLink(
    ctx.env.DB,
    ctx.workspaceId,
    draftFrom(
      { id: issueId, title: remote.title, description: remote.body ?? "", state_type: remote.state === "closed" ? "completed" : "unstarted" },
      repo,
      remote,
      final,
      assigneeLogin,
      null,
    ),
  );
  await publishLink(ctx, ws, issueId);
}

async function reconcileLinked(
  ctx: SyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  repo: RepoRow,
  link: LinkRow,
  issue: IssueRow,
  opts: { actor?: { user: Me; role: Role }; via?: string | null; senderLogin?: string | null },
): Promise<void> {
  const cfg = requireConfig(ctx.env);
  const parts = splitFullName(repo.full_name);
  if (!parts) return;
  let remote: GhIssue;
  try {
    remote = await getIssue(cfg, parts.owner, parts.repo, link.number);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) {
      await unlink(ctx, ws, repo, link, opts);
      return;
    }
    throw e;
  }
  const catalog = await loadLabels(ctx.env.DB, ctx.workspaceId);
  const repoLabels = await cachedLabels(ctx, cfg, repo.full_name);
  const common = commonNames(catalog, repoLabels);
  const states = await loadStates(ctx.env.DB, issue.team_id);
  const { byLogin, byUser } = await loadLogins(ctx.env.DB, ctx.workspaceId);
  const memberSet = new Set(byLogin.keys());
  const senIds = parseIds(issue.label_ids);
  const senNames = senIds.map((id) => catalog.find((label) => label.id === id)?.name ?? "").filter(Boolean);
  const ghNames = (remote.labels ?? []).map((label) => label.name);
  const baseLabels = parseNames(link.base_labels);
  const final = mergeLabels(baseLabels, senNames, ghNames, [...common]);
  const senLogin = issue.assignee_id ? (byUser.get(issue.assignee_id) ?? null) : null;
  const baseAssignee = link.base_assignee?.toLowerCase() || null;
  const ghAssignee = resolveGitHubAssignee(
    (remote.assignees ?? []).map((user) => user.login),
    baseAssignee,
    memberSet,
  );
  const ghBody = remote.body ?? "";
  const senState = senSyncState(issue.state_type, issue.state_name);
  const ghState = githubSyncState(remote.state, remote.state_reason);
  const titleAction = mergeScalar(link.base_title, issue.title, remote.title);
  const bodyAction = mergeScalar(link.base_body, issue.description, ghBody);
  const stateAction = mergeOpenClosed(link.base_state, senState, ghState);
  const labelAction: MergeAction = sameNameSet(final, intersectNames(senNames, common)) && sameNameSet(final, intersectNames(ghNames, common)) ? "none" : sameNameSet(final, intersectNames(ghNames, common)) ? "pull" : "push";
  const assigneeAction = mergeScalar(baseAssignee, senLogin, ghAssignee);
  const failed = failedAssignee(link.last_error);
  const skipAssignee = !!failed && senLogin === failed && (assigneeAction === "push" || assigneeAction === "sen-wins");

  const patch: IssuePatch = {};
  if ((titleAction === "pull") && remote.title !== issue.title) patch.title = remote.title;
  if (bodyAction === "pull" && ghBody !== issue.description) patch.description = ghBody;
  if (stateAction === "pull") {
    const parts = syncStateParts(ghState);
    const stateId = stateIdForGitHub(states, parts.openClosed, parts.reason, issue.state_type);
    if (stateId && stateId !== issue.state_id) patch.stateId = stateId;
  }
  if (labelAction === "pull" || (labelAction === "push" && !sameNameSet(final, intersectNames(senNames, common)))) {
    const nextIds = senLabelIds(senIds, catalog, final, common);
    if (!sameNameSet(nextIds, senIds)) patch.labelIds = nextIds;
  }
  if (assigneeAction === "pull" && !skipAssignee) {
    const nextId = ghAssignee ? (byLogin.get(ghAssignee) ?? null) : null;
    if (nextId !== issue.assignee_id) patch.assigneeId = nextId;
  }

  const ghPatch: GhIssueWrite = {};
  if ((titleAction === "push" || titleAction === "sen-wins") && remote.title !== issue.title) ghPatch.title = issue.title;
  if ((bodyAction === "push" || bodyAction === "sen-wins") && ghBody !== issue.description) ghPatch.body = issue.description;
  if ((stateAction === "push" || stateAction === "sen-wins") && ghState !== senState) {
    const write = githubStateWrite(senState);
    ghPatch.state = write.state;
    ghPatch.state_reason = write.state_reason;
  }
  const desiredLabels = githubLabelList(ghNames, repoLabels, final, common);
  if (labelAction === "push" && !sameNameSet(desiredLabels, ghNames)) ghPatch.labels = desiredLabels;
  let wantAssignees: string[] | null = null;
  if (!skipAssignee && (assigneeAction === "push" || assigneeAction === "sen-wins")) {
    wantAssignees = nextGitHubAssignees((remote.assignees ?? []).map((user) => user.login), baseAssignee, senLogin);
    if (!sameNameSet(wantAssignees, (remote.assignees ?? []).map((user) => user.login))) ghPatch.assignees = wantAssignees;
  }

  let rejected: string | null = null;
  if (Object.keys(ghPatch).length) {
    try {
      remote = await updateIssue(cfg, parts.owner, parts.repo, link.number, ghPatch);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 422 || !ghPatch.assignees) throw e;
      const { assignees: _assignees, ...rest } = ghPatch;
      remote = Object.keys(rest).length ? await updateIssue(cfg, parts.owner, parts.repo, link.number, rest) : remote;
      rejected = senLogin;
    }
  }

  const actor = opts.actor ?? (await resolveGitHubActor(ctx.env.DB, ctx.workspaceId, repo.linked_by, opts.senderLogin ?? null));
  const mutations: Mutation[] = [];
  let conflictId: string | null = null;
  if (Object.keys(patch).length) mutations.push({ type: "issue.update", args: { id: issue.id, patch } });
  if (bodyAction === "sen-wins") {
    conflictId = crypto.randomUUID();
    const room = MARKDOWN_MAX_LENGTH - BODY_CONFLICT_NOTE.length;
    mutations.push({
      type: "comment.create",
      args: { id: conflictId, issueId: issue.id, body: BODY_CONFLICT_NOTE + ghBody.slice(0, Math.max(0, room)) },
    });
  }
  if (mutations.length) {
    await applyGitHubChanges({
      env: ctx.env,
      ws,
      actor,
      via: opts.via,
      scheduleSheets: ctx.scheduleSheets,
      mutations,
    });
  }

  const nextAssignee = rejected || skipAssignee ? baseAssignee : assigneeAction === "pull" ? ghAssignee : senLogin;
  const nextState: SyncState = stateAction === "pull" ? ghState : senState;
  await updateLinkBase(ctx.env.DB, {
    issueId: issue.id,
    url: remote.html_url || link.url,
    title: titleAction === "pull" ? remote.title : issue.title,
    body: bodyAction === "pull" ? ghBody : issue.description,
    state: nextState,
    labels: final,
    assignee: nextAssignee,
    lastError: rejected && senLogin ? assigneeError(senLogin) : skipAssignee ? link.last_error : null,
  });
  await publishLink(ctx, ws, issue.id);
  if (conflictId) await ctx.enqueueComment(conflictId);
}

async function unlink(
  ctx: SyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  repo: RepoRow | null,
  link: LinkRow,
  opts: { actor?: { user: Me; role: Role }; via?: string | null; senderLogin?: string | null },
): Promise<void> {
  const fullName = repo?.full_name ?? "";
  const actor = opts.actor ?? (await resolveGitHubActor(ctx.env.DB, ctx.workspaceId, repo?.linked_by ?? null, opts.senderLogin ?? null));
  await writeGitHubActivity(ctx, ws, { actor, via: opts.via }, link.issue_id, "unlinked", { full_name: fullName }, link.number, link.url);
  await deleteLink(ctx, ws, link.issue_id);
}

async function seededBase(ctx: SyncCtx, cfg: NonNullable<ReturnType<typeof githubConfig>>, repo: RepoRow, issue: IssueRow, remote: GhIssue, prefer: "sen" | "github"): Promise<LinkDraft> {
  const catalog = await loadLabels(ctx.env.DB, ctx.workspaceId);
  const repoLabels = await cachedLabels(ctx, cfg, repo.full_name);
  const common = commonNames(catalog, repoLabels);
  const { byLogin, byUser } = await loadLogins(ctx.env.DB, ctx.workspaceId);
  const senLogin = issue.assignee_id ? (byUser.get(issue.assignee_id) ?? null) : null;
  const ghLogin = resolveGitHubAssignee((remote.assignees ?? []).map((user) => user.login), null, new Set(byLogin.keys()));
  const senNames = parseIds(issue.label_ids).map((id) => catalog.find((label) => label.id === id)?.name ?? "");
  const ghNames = (remote.labels ?? []).map((label) => label.name);
  const senRelevant = intersectNames(senNames, common);
  const ghRelevant = intersectNames(ghNames, common);
  const url = remote.html_url || `https://github.com/${repo.full_name}/issues/${remote.number}`;
  if (prefer === "sen") {
    return {
      issueId: issue.id,
      repoId: repo.repo_id,
      number: remote.number,
      url,
      title: remote.title,
      body: remote.body ?? "",
      state: githubSyncState(remote.state, remote.state_reason),
      labels: ghRelevant,
      assignee: ghLogin,
      lastError: null,
    };
  }
  return {
    issueId: issue.id,
    repoId: repo.repo_id,
    number: remote.number,
    url,
    title: issue.title,
    body: issue.description,
    state: senSyncState(issue.state_type, issue.state_name),
    labels: senRelevant,
    assignee: senLogin,
    lastError: null,
  };
}

async function writeGitHubActivity(
  ctx: SyncCtx,
  ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>,
  opts: { actor: { user: Me; role: Role }; via?: string | null },
  issueId: string,
  action: GitHubActivityData["action"],
  repo: { full_name: string },
  number: number,
  url: string,
): Promise<void> {
  const write: GitHubWrite = {
    env: ctx.env,
    ws,
    actor: opts.actor,
    via: opts.via,
    scheduleSheets: ctx.scheduleSheets,
    activities: [{ issueId, data: { action, repo: repo.full_name, number, url } }],
  };
  await applyGitHubChanges(write);
}

async function cachedLabels(ctx: SyncCtx, cfg: NonNullable<ReturnType<typeof githubConfig>>, fullName: string): Promise<GhLabel[]> {
  const key = fullName.toLowerCase();
  const hit = ctx.labelCache.get(key);
  if (hit) return hit;
  const parts = splitFullName(fullName);
  if (!parts) return [];
  const labels = (await listLabels(cfg, parts.owner, parts.repo)).filter((label) => label && typeof label.name === "string");
  ctx.labelCache.set(key, labels);
  return labels;
}

function requireConfig(env: Env) {
  const cfg = githubConfig(env);
  if (!cfg) fail("このワークスペースでは GitHub 連携が設定されていません", 404);
  return cfg;
}

function rethrowGitHub(e: unknown): never {
  if (e instanceof GitHubError) {
    const status = e.status === 404 || e.status === 410 ? 404 : e.status === 401 || e.status === 403 || e.status === 429 ? e.status : 502;
    fail(e.status === 404 || e.status === 410 ? "GitHub で見つかりませんでした" : e.message, status);
  }
  fail("GitHub との同期に失敗しました", 500);
}

function fail(message: string, status = 400): never {
  throw new MutationError(message, status);
}

function assigneeError(login: string): string {
  return `担当者を GitHub に反映できませんでした（${login}）`;
}

function failedAssignee(error: string | null): string | null {
  return ASSIGNEE_ERROR.exec(error ?? "")?.[1] ?? null;
}

function sinceKey(repoId: number): string {
  return `gh:since:${repoId}`;
}

interface LinkDraft {
  issueId: string;
  repoId: number;
  number: number;
  url: string;
  title: string;
  body: string;
  state: SyncState;
  labels: string[];
  assignee: string | null;
  lastError: string | null;
}

function draftFrom(
  issue: { id: string; title: string; description: string; state_type: StateType },
  repo: RepoRow,
  remote: GhIssue,
  labels: string[],
  assignee: string | null,
  rejected: string | null,
): LinkDraft {
  return {
    issueId: issue.id,
    repoId: repo.repo_id,
    number: remote.number,
    url: remote.html_url || `https://github.com/${repo.full_name}/issues/${remote.number}`,
    title: remote.title || issue.title,
    body: remote.body ?? issue.description,
    state: githubSyncState(remote.state, remote.state_reason),
    labels,
    assignee: rejected ? null : assignee,
    lastError: rejected ? assigneeError(rejected) : null,
  };
}

async function insertLink(db: D1Database, workspaceId: string, draft: LinkDraft): Promise<void> {
  const now = Date.now();
  await run(
    db,
    `INSERT INTO github_issue_links (
       issue_id, workspace_id, repo_id, number, url, base_title, base_body, base_state, base_labels, base_assignee,
       synced_at, last_error, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    draft.issueId,
    workspaceId,
    draft.repoId,
    draft.number,
    draft.url,
    draft.title,
    draft.body,
    draft.state,
    JSON.stringify(draft.labels),
    draft.assignee,
    now,
    draft.lastError,
    now,
  );
}

async function updateLinkBase(
  db: D1Database,
  row: { issueId: string; url: string; title: string; body: string; state: string; labels: string[]; assignee: string | null; lastError: string | null },
): Promise<void> {
  await run(
    db,
    `UPDATE github_issue_links
     SET url = ?, base_title = ?, base_body = ?, base_state = ?, base_labels = ?, base_assignee = ?, synced_at = ?, last_error = ?
     WHERE issue_id = ?`,
    row.url,
    row.title,
    row.body,
    row.state,
    JSON.stringify(row.labels),
    row.assignee,
    Date.now(),
    row.lastError,
    row.issueId,
  );
}

async function publishLink(ctx: SyncCtx, ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>, issueId: string): Promise<void> {
  await commitGitHubChanges(ctx.env, ws, [{ entity: "githubLink", entityId: issueId, op: "upsert" }], ctx.scheduleSheets);
}

async function deleteLink(ctx: SyncCtx, ws: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>>, issueId: string): Promise<void> {
  await run(ctx.env.DB, "DELETE FROM github_issue_links WHERE issue_id = ? AND workspace_id = ?", issueId, ctx.workspaceId);
  await commitGitHubChanges(ctx.env, ws, [{ entity: "githubLink", entityId: issueId, op: "delete" }], ctx.scheduleSheets);
}

async function loadIssue(db: D1Database, workspaceId: string, issueId: string): Promise<IssueRow | null> {
  return first<IssueRow>(
    db,
    `SELECT i.id, i.team_id, i.title, i.description, i.state_id, i.assignee_id, i.label_ids, i.created_at, i.archived_at, s.type AS state_type, s.name AS state_name
     FROM issues i JOIN workflow_states s ON s.id = i.state_id
     WHERE i.id = ? AND i.workspace_id = ?`,
    issueId,
    workspaceId,
  );
}

async function loadStates(db: D1Database, teamId: string): Promise<WorkflowStateRef[]> {
  return all<WorkflowStateRef>(db, "SELECT id, name, type, position FROM workflow_states WHERE team_id = ? ORDER BY position", teamId);
}

async function loadLabels(db: D1Database, workspaceId: string): Promise<LabelRow[]> {
  return all<LabelRow>(db, "SELECT id, name FROM labels WHERE workspace_id = ?", workspaceId);
}

async function loadLogins(db: D1Database, workspaceId: string): Promise<{ byLogin: Map<string, string>; byUser: Map<string, string> }> {
  const rows = await all<{ id: string; github_login: string | null }>(
    db,
    `SELECT u.id, u.github_login FROM users u JOIN members m ON m.user_id = u.id
     WHERE m.workspace_id = ? AND u.github_login IS NOT NULL`,
    workspaceId,
  );
  const byLogin = new Map<string, string>();
  const byUser = new Map<string, string>();
  for (const row of rows) {
    if (!row.github_login) continue;
    byLogin.set(row.github_login, row.id);
    byUser.set(row.id, row.github_login);
  }
  return { byLogin, byUser };
}

async function memberHasLogin(db: D1Database, workspaceId: string, login: string): Promise<boolean> {
  const row = await first(
    db,
    `SELECT u.id FROM users u JOIN members m ON m.user_id = u.id
     WHERE m.workspace_id = ? AND u.github_login = ?`,
    workspaceId,
    login.trim().toLowerCase(),
  );
  return !!row;
}

async function createdViaGitHub(db: D1Database, issueId: string): Promise<boolean> {
  const row = await first<{ via: string | null }>(db, "SELECT via FROM activities WHERE issue_id = ? AND type = 'created' ORDER BY created_at LIMIT 1", issueId);
  return row?.via === "GitHub";
}

async function repoByTeam(db: D1Database, workspaceId: string, teamId: string): Promise<RepoRow | null> {
  return first<RepoRow>(db, "SELECT team_id, repo_id, full_name, linked_by, linked_at FROM github_repos WHERE team_id = ? AND workspace_id = ?", teamId, workspaceId);
}

async function repoById(db: D1Database, workspaceId: string, repoId: number): Promise<RepoRow | null> {
  return first<RepoRow>(db, "SELECT team_id, repo_id, full_name, linked_by, linked_at FROM github_repos WHERE repo_id = ? AND workspace_id = ?", repoId, workspaceId);
}

async function linkByIssue(db: D1Database, workspaceId: string, issueId: string): Promise<LinkRow | null> {
  return first<LinkRow>(db, "SELECT * FROM github_issue_links WHERE issue_id = ? AND workspace_id = ?", issueId, workspaceId);
}

async function linkByNumber(db: D1Database, workspaceId: string, repoId: number, number: number): Promise<LinkRow | null> {
  return first<LinkRow>(db, "SELECT * FROM github_issue_links WHERE workspace_id = ? AND repo_id = ? AND number = ?", workspaceId, repoId, number);
}

function parseIds(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function parseNames(raw: string | null): string[] {
  return parseIds(raw).map((name) => name.toLowerCase());
}

function commonNames(sen: LabelRow[], github: GhLabel[]): Set<string> {
  const remote = new Set(github.map((label) => label.name.toLowerCase()));
  const out = new Set<string>();
  for (const label of sen) if (remote.has(label.name.toLowerCase())) out.add(label.name.toLowerCase());
  return out;
}

function intersectNames(values: string[], common: Set<string>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const name = value.toLowerCase();
    if (name && common.has(name)) out.add(name);
  }
  return [...out];
}

function senLabelIds(current: string[], catalog: LabelRow[], final: string[], common: Set<string>): string[] {
  const byId = new Map(catalog.map((label) => [label.id, label]));
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const id of current) {
    const label = byId.get(id);
    if (!label || common.has(label.name.toLowerCase()) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const name of final) {
    const found = catalog.find((label) => label.name.toLowerCase() === name);
    if (!found || seen.has(found.id)) continue;
    seen.add(found.id);
    kept.push(found.id);
  }
  return kept;
}

function githubLabelList(current: string[], repoLabels: GhLabel[], final: string[], common: Set<string>): string[] {
  const casing = new Map(repoLabels.map((label) => [label.name.toLowerCase(), label.name]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of current) {
    const key = name.toLowerCase();
    if (!key || common.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  for (const name of final) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(casing.get(name) ?? name);
  }
  return out;
}

async function commentUuid(githubCommentId: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sen:gh-comment:${githubCommentId}`));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
