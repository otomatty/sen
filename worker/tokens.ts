// AI ツール（MCP）から接続するための個人用トークン。
// トークンそのものは保存せず、SHA-256 のハッシュだけを持つ。

import type { Context } from "hono";
import { apiTokenClientLabel } from "../shared/constants";
import type { ApiTokenClient, ApiTokenCreateRequest, ApiTokenScope, ApiTokenSummary, Me, Role } from "../shared/types";
import { randomToken } from "./auth";
import { all, first, run } from "./db";
import type { AppEnv, WorkspaceRow } from "./env";
import { MutationError } from "./mutations";
import { toMe } from "./serialize";

export const TOKEN_PREFIX = "sen_";
const TOKEN_RE = /^sen_[A-Za-z0-9_-]{43}$/;
const MAX_TOKENS_PER_USER = 20;
/** 最終利用時刻は、連続したリクエストで毎回書き込まない */
const LAST_USED_INTERVAL = 60_000;
const DAY_MS = 86_400_000;

export interface ApiTokenAuth {
  tokenId: string;
  scope: ApiTokenScope;
  /** 履歴・コメント・通知に残すツール名 */
  via: string;
  user: Me;
  ws: WorkspaceRow;
  role: Role;
}

interface TokenRow {
  id: string;
  name: string;
  client: string;
  scope: string;
  token_hint: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

/** base64url で 43 文字。TOKEN_PREFIX と合わせて TOKEN_RE に合う */
export function generateToken(): string {
  return TOKEN_PREFIX + randomToken(32);
}

/** 保存・照合に使う SHA-256 の 16 進文字列 */
export async function hashToken(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toTokenSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    client: row.client as ApiTokenClient,
    scope: row.scope as ApiTokenScope,
    hint: row.token_hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

function isClient(v: string): v is ApiTokenClient {
  return v === "claude-code" || v === "cursor" || v === "vscode" || v === "other";
}

/** 履歴に残す名前。その他以外はクライアントの表示名、その他はトークン名 */
export function viaLabel(row: { client: string; name: string }): string {
  if (row.client === "other") return row.name;
  if (isClient(row.client)) return apiTokenClientLabel(row.client);
  return "その他";
}

/** 公開 URL。BETTER_AUTH_URL があればそれ（末尾の / は除く）、無ければリクエストのオリジン */
export function publicOrigin(c: Context<AppEnv>): string {
  const configured = c.env.BETTER_AUTH_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(c.req.url).origin;
}

export async function listTokens(db: D1Database, workspaceId: string, userId: string): Promise<ApiTokenSummary[]> {
  const rows = await all<TokenRow>(
    db,
    "SELECT * FROM api_tokens WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC",
    workspaceId,
    userId,
  );
  return rows.map(toTokenSummary);
}

function cleanTokenName(raw: unknown, client: ApiTokenClient): string {
  const fallback = client === "other" ? "AI ツール" : apiTokenClientLabel(client);
  if (raw == null) return fallback;
  if (typeof raw !== "string") throw new MutationError("名前が不正です");
  const cleaned = Array.from(raw.replace(/[\u0000-\u001F\u007F]/g, "").trim()).slice(0, 40).join("");
  return cleaned || fallback;
}

export async function createToken(
  db: D1Database,
  input: { workspaceId: string; userId: string; req: ApiTokenCreateRequest; now: number },
): Promise<{ summary: ApiTokenSummary; secret: string }> {
  const { workspaceId, userId, req, now } = input;
  const client = req?.client;
  if (client !== "claude-code" && client !== "cursor" && client !== "vscode" && client !== "other") {
    throw new MutationError("連携先が不正です");
  }
  const scope = req?.scope;
  if (scope !== "read" && scope !== "write") throw new MutationError("権限が不正です");
  const expiresInDays = req?.expiresInDays;
  if (expiresInDays !== 30 && expiresInDays !== 90 && expiresInDays !== 365 && expiresInDays !== null) {
    throw new MutationError("有効期限が不正です");
  }
  const name = cleanTokenName(req?.name, client);
  const count = await first<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM api_tokens WHERE workspace_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)",
    workspaceId,
    userId,
    now,
  );
  if ((count?.c ?? 0) >= MAX_TOKENS_PER_USER) {
    throw new MutationError("トークンは20個まで発行できます。使っていないトークンを無効にしてください");
  }
  const secret = generateToken();
  const id = crypto.randomUUID();
  const row: TokenRow = {
    id,
    name,
    client,
    scope,
    token_hint: secret.slice(-4),
    created_at: now,
    last_used_at: null,
    expires_at: expiresInDays == null ? null : now + expiresInDays * DAY_MS,
  };
  await run(
    db,
    `INSERT INTO api_tokens
       (id, workspace_id, user_id, name, client, scope, token_hash, token_hint, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    row.id,
    workspaceId,
    userId,
    row.name,
    row.client,
    row.scope,
    await hashToken(secret),
    row.token_hint,
    row.created_at,
    row.expires_at,
  );
  return { summary: toTokenSummary(row), secret };
}

/** 自分のトークンだけ削除できる */
export async function deleteToken(db: D1Database, workspaceId: string, userId: string, id: string): Promise<void> {
  const row = await first<{ id: string }>(
    db,
    "SELECT id FROM api_tokens WHERE id = ? AND workspace_id = ? AND user_id = ?",
    id,
    workspaceId,
    userId,
  );
  if (!row) throw new MutationError("トークンが見つかりません", 404);
  await run(db, "DELETE FROM api_tokens WHERE id = ? AND workspace_id = ? AND user_id = ?", id, workspaceId, userId);
}

interface AuthRow {
  token_id: string;
  scope: string;
  client: string;
  token_name: string;
  last_used_at: number | null;
  expires_at: number | null;
  role: string;
  ws_id: string;
  ws_name: string;
  url_key: string;
  invite_code: string;
  ws_created_at: number;
  ws_updated_at: number;
  user_id: string;
  email: string;
  user_name: string;
  avatar_color: string;
  settings: string;
  github_login: string | null;
  user_created_at: number;
}

/**
 * Authorization: Bearer の API トークンを照合する。
 * 形式が違う、メンバーでない、期限切れのときは null（Cookie のログインとは別経路）。
 */
export async function authenticateApiToken(
  db: D1Database,
  authorizationHeader: string | null | undefined,
  now: number,
): Promise<ApiTokenAuth | null> {
  if (!authorizationHeader) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
  if (!m || !TOKEN_RE.test(m[1])) return null;
  const row = await first<AuthRow>(
    db,
    `SELECT
       t.id AS token_id,
       t.scope AS scope,
       t.client AS client,
       t.name AS token_name,
       t.last_used_at AS last_used_at,
       t.expires_at AS expires_at,
       m.role AS role,
       w.id AS ws_id,
       w.name AS ws_name,
       w.url_key AS url_key,
       w.invite_code AS invite_code,
       w.created_at AS ws_created_at,
       w.updated_at AS ws_updated_at,
       u.id AS user_id,
       u.email AS email,
       u.name AS user_name,
       u.avatar_color AS avatar_color,
       u.settings AS settings,
       u.github_login AS github_login,
       u.created_at AS user_created_at
     FROM api_tokens t
     JOIN members m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
     JOIN workspaces w ON w.id = t.workspace_id
     JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ?`,
    await hashToken(m[1]),
  );
  if (!row) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  if (row.scope !== "read" && row.scope !== "write") return null;
  if (row.role !== "admin" && row.role !== "member") return null;
  if (row.last_used_at == null || now - row.last_used_at >= LAST_USED_INTERVAL) {
    await run(db, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", now, row.token_id);
  }
  const ws: WorkspaceRow = {
    id: row.ws_id,
    name: row.ws_name,
    url_key: row.url_key,
    invite_code: row.invite_code,
    created_at: row.ws_created_at,
    updated_at: row.ws_updated_at,
  };
  return {
    tokenId: row.token_id,
    scope: row.scope,
    via: viaLabel({ client: row.client, name: row.token_name }),
    user: toMe({
      id: row.user_id,
      name: row.user_name,
      email: row.email,
      avatar_color: row.avatar_color,
      role: row.role,
      settings: row.settings,
      github_login: row.github_login,
      created_at: row.user_created_at,
    }),
    ws,
    role: row.role,
  };
}
