import type { Context } from "hono";
import { isEmailAllowed, parseAllowedDomains } from "../../shared/domains";
import type { AiConnectionsResponse, ApiTokenScope, OAuthGrantSummary, Role } from "../../shared/types";
import { all, first, run, stmt } from "../db";
import type { AppEnv, WorkspaceRow } from "../env";
import { MutationError } from "../mutations";
import { toMe } from "../serialize";
import { authenticateApiToken, hashToken, listTokens, publicOrigin, type ApiTokenAuth } from "../tokens";

export interface GrantRow {
  id: string;
  client_id: string;
  workspace_id: string;
  user_id: string;
  scope: ApiTokenScope;
  client_name: string;
  refresh_hash: string;
  prev_refresh_hash: string | null;
  rotated_at: number | null;
  refresh_expires_at: number;
  created_at: number;
  last_used_at: number | null;
}

/** トークン交換時にも所属とメールドメインを確認する */
export async function isGrantMember(db: D1Database, workspaceId: string, userId: string): Promise<boolean> {
  const row = await first<{ role: Role; email: string; allowed_domains: string }>(db,
    `SELECT m.role, u.email, w.allowed_domains FROM members m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?`, workspaceId, userId);
  return !!row && (row.role === "admin" || row.role === "member") && isEmailAllowed(row.email, parseAllowedDomains(row.allowed_domains));
}

/** 接続と、それに属する全アクセストークンを一緒に失効させる */
export async function deleteGrant(db: D1Database, id: string): Promise<void> {
  await db.batch([
    stmt(db, "DELETE FROM oauth_access_tokens WHERE grant_id = ?", id),
    stmt(db, "DELETE FROM oauth_refresh_used WHERE grant_id = ?", id),
    stmt(db, "DELETE FROM oauth_grants WHERE id = ?", id),
  ]);
}

/** 個人トークンと OAuth を Cookie に依存しない同じ認証結果に揃える */
export async function authenticateBearer(db: D1Database, authorizationHeader: string | null | undefined, now: number): Promise<ApiTokenAuth | null> {
  const match = authorizationHeader && /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
  if (!match) return null;
  if (/^sen_[A-Za-z0-9_-]{43}$/.test(match[1])) return authenticateApiToken(db, authorizationHeader, now);
  if (!/^sen_at_[A-Za-z0-9_-]{43}$/.test(match[1])) return null;
  const row = await first<{
    id: string; scope: ApiTokenScope; client_name: string; last_used_at: number | null; role: Role;
    ws_id: string; ws_name: string; url_key: string; allowed_domains: string; ws_created_at: number; ws_updated_at: number;
    user_id: string; email: string; name: string; avatar_color: string; settings: string; github_login: string | null; created_at: number;
  }>(db, `SELECT g.id, g.scope, g.client_name, g.last_used_at, m.role,
    w.id AS ws_id, w.name AS ws_name, w.url_key, w.allowed_domains, w.created_at AS ws_created_at, w.updated_at AS ws_updated_at,
    u.id AS user_id, u.email, u.name, u.avatar_color, u.settings, u.github_login, u.created_at
    FROM oauth_access_tokens a JOIN oauth_grants g ON g.id = a.grant_id
    JOIN members m ON m.workspace_id = g.workspace_id AND m.user_id = g.user_id
    JOIN workspaces w ON w.id = g.workspace_id JOIN users u ON u.id = g.user_id
    WHERE a.token_hash = ? AND a.expires_at > ?`, await hashToken(match[1]), now);
  if (!row || (row.role !== "admin" && row.role !== "member") || (row.scope !== "read" && row.scope !== "write") || !isEmailAllowed(row.email, parseAllowedDomains(row.allowed_domains))) return null;
  if (row.last_used_at == null || now - row.last_used_at >= 60_000) {
    await run(db, "UPDATE oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)", now, row.id, now - 60_000);
  }
  const ws: WorkspaceRow = { id: row.ws_id, name: row.ws_name, url_key: row.url_key, allowed_domains: row.allowed_domains, created_at: row.ws_created_at, updated_at: row.ws_updated_at };
  return { kind: "oauth", tokenId: row.id, scope: row.scope, via: row.client_name, role: row.role, ws,
    user: toMe({ id: row.user_id, email: row.email, name: row.name, avatar_color: row.avatar_color, settings: row.settings, github_login: row.github_login, created_at: row.created_at, role: row.role }),
  };
}

export async function listConnections(c: Context<AppEnv>): Promise<Response> {
  const ws = c.get("workspace").id, user = c.get("user").id;
  const grants = await all<OAuthGrantSummary>(c.env.DB, `SELECT id, client_name AS clientName, scope, created_at AS createdAt, last_used_at AS lastUsedAt FROM oauth_grants WHERE workspace_id = ? AND user_id = ? AND refresh_expires_at > ? ORDER BY created_at DESC`, ws, user, Date.now());
  const body: AiConnectionsResponse = { grants, tokens: await listTokens(c.env.DB, ws, user), mcpUrl: `${publicOrigin(c)}/api/mcp` };
  return c.json(body);
}

export async function deleteConnection(c: Context<AppEnv>): Promise<Response> {
  const row = await first<{ id: string }>(c.env.DB, "SELECT id FROM oauth_grants WHERE id = ? AND workspace_id = ? AND user_id = ?", c.req.param("id") ?? "", c.get("workspace").id, c.get("user").id);
  if (!row) throw new MutationError("接続が見つかりません", 404);
  await deleteGrant(c.env.DB, row.id);
  return c.json({ ok: true });
}

/** 期限切れの認可データと、参照されていない古いクライアントを毎日掃除する */
export async function cleanupOAuth(db: D1Database, now: number): Promise<void> {
  const cutoff = now - 30 * 86_400_000;
  await db.batch([
    stmt(db, "DELETE FROM oauth_requests WHERE expires_at <= ?", now),
    stmt(db, "DELETE FROM oauth_codes WHERE expires_at <= ?", now),
    stmt(db, "DELETE FROM oauth_access_tokens WHERE expires_at <= ? OR grant_id IN (SELECT id FROM oauth_grants WHERE refresh_expires_at <= ?)", now, now),
    stmt(db, `DELETE FROM oauth_refresh_used WHERE created_at < ?
      OR NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_refresh_used.grant_id)
      OR grant_id IN (SELECT id FROM oauth_grants WHERE refresh_expires_at <= ?)`, now - 90 * 86_400_000, now),
    stmt(db, "DELETE FROM oauth_grants WHERE refresh_expires_at <= ?", now),
    stmt(db, `DELETE FROM oauth_clients WHERE kind = 'dcr' AND created_at < ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.client_id = oauth_clients.client_id AND c.used_at IS NULL)`, cutoff),
    stmt(db, `DELETE FROM oauth_clients WHERE kind = 'cimd' AND fetched_at < ? AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)`, cutoff),
  ]);
}
