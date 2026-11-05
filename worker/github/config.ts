// GitHub 連携の設定と、Durable Object への依頼。
// ブラウザ内デモ（demo/backend.ts → worker/app.ts）からも読み込まれるため、
// cloudflare:workers や Node の API は使わない。

import type { Change } from "../sync";
import { all } from "../db";
import type { Env, WorkspaceRow } from "../env";
import { githubWebhookReady } from "./signature";

const API_ORIGIN = "https://api.github.com";
const DEFAULT_DELAY_MS = 3_000;

export interface GitHubConfig {
  workspaceKey: string;
  token: string;
  webhookSecret: string;
  delayMs: number;
  /** API のオリジン（パスは付けない） */
  apiOrigin: string;
}

/** WORKSPACE・TOKEN・WEBHOOK_SECRET と REALTIME が揃っていれば設定を返す。欠けていれば null（何もしない） */
export function githubConfig(env: Env): GitHubConfig | null {
  if (!githubWebhookReady(env)) return null;
  return {
    workspaceKey: env.GITHUB_WORKSPACE!.trim(),
    token: env.GITHUB_TOKEN!.trim(),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET!.trim(),
    delayMs: syncDelayMs(env.GITHUB_SYNC_DELAY_MS),
    apiOrigin: apiOrigin(env),
  };
}

/** 連携が有効で、このワークスペースが対象か */
export function isGitHubTarget(env: Env, wsUrlKey: string): boolean {
  const cfg = githubConfig(env);
  return cfg !== null && cfg.workspaceKey === wsUrlKey;
}

export function githubWebhookUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/github/webhook`;
}

/**
 * 対象ワークスペースで、課題の変更かコメントの追加があれば Durable Object に印を付ける。
 * via が "GitHub" の変更（同期そのもの）では何もしない。失敗しても例外は出さない。
 */
export async function scheduleGitHubSync(
  env: Env,
  ws: WorkspaceRow,
  changes: Change[],
  via: string | null | undefined,
): Promise<void> {
  if (via === "GitHub") return;
  if (!isGitHubTarget(env, ws.url_key)) return;
  const issues = [...new Set(changes.filter((ch) => ch.entity === "issue" && ch.op === "upsert").map((ch) => ch.entityId))];
  const commentIds = [...new Set(changes.filter((ch) => ch.entity === "comment" && ch.op === "upsert").map((ch) => ch.entityId))];
  const comments = await addedCommentIds(env, ws.id, commentIds);
  if (issues.length === 0 && comments.length === 0) return;
  try {
    const res = await githubRealtime(env, ws.id, "/github/mark", { workspaceId: ws.id, issues, comments });
    if (!res.ok) console.error("github schedule failed", res.status);
  } catch (e) {
    console.error("github schedule failed", e instanceof Error ? e.name : "error");
  }
}

/** 対象ワークスペースの Durable Object を呼ぶ。REALTIME が無いときは例外 */
export async function githubRealtime(env: Env, workspaceId: string, path: string, body?: unknown): Promise<Response> {
  const ns = env.REALTIME;
  if (!ns) throw new Error("リアルタイム同期は無効です");
  return ns.get(ns.idFromName(workspaceId)).fetch(`https://realtime${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 編集済みと、GitHub から取り込んだコメントは印を付けない */
async function addedCommentIds(env: Env, workspaceId: string, ids: string[]): Promise<string[]> {
  const found: string[] = [];
  const chunkSize = 90;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await all<{ id: string }>(
      env.DB,
      `SELECT id FROM comments WHERE workspace_id = ? AND edited_at IS NULL AND github_author IS NULL AND id IN (${placeholders})`,
      workspaceId,
      ...chunk,
    );
    for (const row of rows) found.push(row.id);
  }
  return found;
}

function apiOrigin(env: Env): string {
  const override = env.DEV_TOOLS === "1" ? env.GITHUB_API_ORIGIN_FOR_TESTS?.trim() : "";
  return override?.replace(/\/+$/, "") || API_ORIGIN;
}

/** 省略・不正な値は 3 秒。0 は「待たずに送る」として許す */
function syncDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DELAY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DELAY_MS;
  return n;
}
