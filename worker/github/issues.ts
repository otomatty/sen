// 課題の画面と毎日の Cron から、Durable Object に GitHub の操作を頼む。
// ここは受け付けだけ。GitHub への書き込みは Durable Object の中で、同じ課題の処理と重ならないように行う。

import { first } from "../db";
import type { Env, WorkspaceRow } from "../env";
import { MutationError } from "../mutations";
import { githubConfig, githubRealtime, isGitHubTarget } from "./config";

export interface GitHubIssueOp {
  action: "create" | "link" | "unlink";
  ref?: string;
  prefer?: "sen" | "github";
}

export async function requestGitHubIssueOp(env: Env, ws: WorkspaceRow, userId: string, issueId: string, op: GitHubIssueOp): Promise<void> {
  if (!isGitHubTarget(env, ws.url_key)) throw new MutationError("このワークスペースでは GitHub 連携が設定されていません", 404);
  const res = await githubRealtime(env, ws.id, "/github/issue", {
    workspaceId: ws.id,
    userId,
    issueId,
    action: op.action,
    ref: op.ref,
    prefer: op.prefer,
  });
  if (!res.ok) await failResponse(res);
}

/** 対象ワークスペースのリポジトリを、前回以降の変更で突き合わせる */
export async function requestGitHubReconcile(env: Env): Promise<void> {
  const cfg = githubConfig(env);
  if (!cfg || !env.REALTIME) return;
  const ws = await first<WorkspaceRow>(env.DB, "SELECT * FROM workspaces WHERE url_key = ?", cfg.workspaceKey);
  if (!ws) return;
  const res = await githubRealtime(env, ws.id, "/github/reconcile", { workspaceId: ws.id });
  if (!res.ok) console.error("github reconcile request failed", res.status);
}

/** 開発用。指定したワークスペースが対象のときだけ */
export async function requestWorkspaceGitHubReconcile(env: Env, ws: WorkspaceRow): Promise<void> {
  if (!isGitHubTarget(env, ws.url_key)) throw new MutationError("このワークスペースでは GitHub 連携が設定されていません", 404);
  const res = await githubRealtime(env, ws.id, "/github/reconcile", { workspaceId: ws.id });
  if (!res.ok) await failResponse(res);
}

async function failResponse(res: Response): Promise<never> {
  let message = "GitHub との同期に失敗しました";
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error) message = data.error;
  } catch {
    // 本文が無くても、ステータスだけで返す
  }
  const status = res.status >= 400 && res.status < 600 ? res.status : 502;
  throw new MutationError(message, status);
}
