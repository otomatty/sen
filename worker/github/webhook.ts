// POST /api/github/webhook。署名を確かめてから、重い処理は Durable Object に渡す。
// トークンと secret は応答にもログにも出さない。

import { all, first, run } from "../db";
import type { Env, WorkspaceRow } from "../env";
import { notifyRealtime, writeChanges } from "../sync";
import { githubRealtime, isGitHubTarget } from "./config";
import type { GitHubCommentEvent, GitHubIncoming, GitHubPullEvent } from "./events";
import { acceptGitHubWebhook } from "./signature";

const PULL_ACTIONS = new Set(["opened", "edited", "reopened", "closed", "converted_to_draft", "ready_for_review"]);

interface RepoPayload {
  id?: unknown;
  full_name?: unknown;
}

/** 設定が無ければ 503。署名が無いか違うなら 401。受け取れたら 202（ping と重複は 200） */
export async function handleGitHubWebhook(request: Request, env: Env): Promise<Response> {
  const accepted = await acceptGitHubWebhook(request, env);
  if (accepted instanceof Response) return accepted;
  const raw = accepted.raw;

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return Response.json({ error: "JSON を読み取れませんでした" }, { status: 400 });
  }

  const delivery = request.headers.get("x-github-delivery")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(delivery)) {
    return Response.json({ error: "配送 ID がありません" }, { status: 400 });
  }

  const claimed = await claimDelivery(env.DB, delivery, Date.now());
  if (!claimed) return new Response(null, { status: 200 });

  const event = request.headers.get("x-github-event")?.trim() ?? "";
  try {
    if (event === "ping") return new Response(null, { status: 200 });
    const incoming = toIncoming(event, payload);
    if (!incoming) return new Response(null, { status: 202 });

    const repo = readRepo(payload);
    if (!repo) return new Response(null, { status: 202 });
    const row = await first<{ team_id: string; workspace_id: string; full_name: string }>(
      env.DB,
      "SELECT team_id, workspace_id, full_name FROM github_repos WHERE repo_id = ?",
      repo.id,
    );
    if (!row) return new Response(null, { status: 202 });
    const ws = await first<WorkspaceRow>(env.DB, "SELECT * FROM workspaces WHERE id = ?", row.workspace_id);
    if (!ws || !isGitHubTarget(env, ws.url_key)) return new Response(null, { status: 202 });

    if (repo.fullName !== row.full_name) {
      try {
        await renameRepo(env, ws.id, row.team_id, repo.id, repo.fullName);
      } catch (e) {
        console.error("github rename failed", e instanceof Error ? e.name : "error");
      }
    }

    const res = await githubRealtime(env, ws.id, "/github/event", { workspaceId: ws.id, incoming });
    if (!res.ok) throw new Error("enqueue failed");
    return new Response(null, { status: 202 });
  } catch (e) {
    await run(env.DB, "DELETE FROM github_deliveries WHERE id = ?", delivery).catch(() => undefined);
    console.error("github webhook failed", e instanceof Error ? e.name : "error");
    return Response.json({ error: "受け付けられませんでした" }, { status: 500 });
  }
}

async function claimDelivery(db: D1Database, id: string, now: number): Promise<boolean> {
  const existing = await first<{ id: string }>(db, "SELECT id FROM github_deliveries WHERE id = ?", id);
  if (existing) return false;
  try {
    await run(db, "INSERT INTO github_deliveries (id, received_at) VALUES (?, ?)", id, now);
    return true;
  } catch (e) {
    const again = await first<{ id: string }>(db, "SELECT id FROM github_deliveries WHERE id = ?", id);
    if (again) return false;
    throw e;
  }
}

async function renameRepo(env: Env, workspaceId: string, teamId: string, repoId: number, fullName: string): Promise<void> {
  const now = Date.now();
  await run(env.DB, "UPDATE github_repos SET full_name = ?, updated_at = ? WHERE team_id = ?", fullName, now, teamId);
  await run(env.DB, "UPDATE github_pull_links SET repo = ?, updated_at = ? WHERE workspace_id = ? AND repo_id = ?", fullName, now, workspaceId, repoId);
  const links = await listIds(env.DB, "SELECT issue_id AS id FROM github_issue_links WHERE workspace_id = ? AND repo_id = ?", workspaceId, repoId);
  const pulls = await listIds(env.DB, "SELECT id FROM github_pull_links WHERE workspace_id = ? AND repo_id = ?", workspaceId, repoId);
  const last = await writeChanges(env.DB, workspaceId, [
    { entity: "githubRepo", entityId: teamId, op: "upsert" },
    ...links.map((id) => ({ entity: "githubLink" as const, entityId: id, op: "upsert" as const })),
    ...pulls.map((id) => ({ entity: "githubPull" as const, entityId: id, op: "upsert" as const })),
  ]);
  await notifyRealtime(env, workspaceId, last);
}

async function listIds(db: D1Database, sql: string, workspaceId: string, repoId: number): Promise<string[]> {
  const rows = await all<{ id: string }>(db, sql, workspaceId, repoId);
  return rows.map((row) => row.id);
}

function readRepo(payload: unknown): { id: number; fullName: string } | null {
  const repo = (payload as { repository?: RepoPayload } | null)?.repository;
  const id = repo?.id;
  const fullName = repo?.full_name;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (typeof fullName !== "string" || !fullName.includes("/")) return null;
  return { id, fullName };
}

function toIncoming(event: string, payload: unknown): GitHubIncoming | null {
  const body = payload as {
    action?: unknown;
    issue?: { number?: unknown };
    comment?: { id?: unknown; body?: unknown; html_url?: unknown; created_at?: unknown; user?: { login?: unknown } | null };
    pull_request?: {
      number?: unknown;
      title?: unknown;
      body?: unknown;
      html_url?: unknown;
      state?: unknown;
      draft?: unknown;
      merged?: unknown;
      user?: { login?: unknown } | null;
      head?: { ref?: unknown };
    };
    repository?: RepoPayload;
    sender?: { login?: unknown } | null;
  };
  const repo = readRepo(payload);
  if (!repo) return null;
  if (event === "issues") {
    const number = body.issue?.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number)) return null;
    return { type: "issue", repoId: repo.id, number };
  }
  if (event === "issue_comment") {
    if (body.action !== "created") return null;
    const number = body.issue?.number;
    const commentId = body.comment?.id;
    if (typeof number !== "number" || typeof commentId !== "number") return null;
    const comment: GitHubCommentEvent = {
      action: "created",
      comment: {
        id: commentId,
        body: typeof body.comment?.body === "string" ? body.comment.body : "",
        html_url: typeof body.comment?.html_url === "string" ? body.comment.html_url : "",
        created_at: typeof body.comment?.created_at === "string" ? body.comment.created_at : "",
        user: loginOf(body.comment?.user ?? null),
      },
      issue: { number },
      repository: { id: repo.id, full_name: repo.fullName },
      sender: loginOf(body.sender ?? null),
    };
    return { type: "comment", repoId: repo.id, number, githubCommentId: commentId, payload: comment };
  }
  if (event === "pull_request") {
    if (typeof body.action !== "string" || !PULL_ACTIONS.has(body.action)) return null;
    const pull = body.pull_request;
    const number = pull?.number;
    if (!pull || typeof number !== "number") return null;
    const stored: GitHubPullEvent = {
      action: body.action,
      pull_request: {
        number,
        title: typeof pull.title === "string" ? pull.title : "",
        body: typeof pull.body === "string" ? pull.body : null,
        html_url: typeof pull.html_url === "string" ? pull.html_url : "",
        state: typeof pull.state === "string" ? pull.state : "",
        draft: pull.draft === true,
        merged: pull.merged === true,
        user: loginOf(pull.user ?? null),
        head: { ref: typeof pull.head?.ref === "string" ? pull.head.ref : "" },
      },
      repository: { id: repo.id, full_name: repo.fullName },
      sender: loginOf(body.sender ?? null),
    };
    return { type: "pull", repoId: repo.id, number, payload: stored };
  }
  return null;
}

function loginOf(user: { login?: unknown } | null): { login: string } | null {
  return user && typeof user.login === "string" && user.login ? { login: user.login } : null;
}
