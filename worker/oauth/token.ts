import type { Context } from "hono";
import type { ApiTokenScope } from "../../shared/types";
import { randomToken } from "../auth";
import { first, stmt } from "../db";
import type { AppEnv } from "../env";
import { hashToken, publicOrigin } from "../tokens";
import { PKCE_RE } from "./authorize";
import { resolveClient, type OAuthClient } from "./clients";
import { deleteGrant, isGrantMember, type GrantRow } from "./grants";
import { isAllowedResource } from "./metadata";

const REFRESH_LIFETIME = 90 * 86_400_000;
type Params = Record<string, string>;

function error(c: Context<AppEnv>, code: string, description = "認証情報が不正か、有効期限が切れています", basic = false): Response {
  if (code === "invalid_client" && basic) {
    return c.json({ error: code, error_description: description }, 401, { "WWW-Authenticate": 'Basic realm="sen"' });
  }
  return c.json({ error: code, error_description: description }, 400);
}

/** フォームと JSON のどちらでも、文字列の値だけを受け取る */
async function readParams(c: Context<AppEnv>): Promise<Params | null> {
  try {
    const raw: unknown = c.req.header("content-type")?.split(";")[0].trim() === "application/json" ? await c.req.json() : await c.req.parseBody();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return null; }
}

/** Basic の各値はフォームと同じ URL エンコード規則で復号する */
async function authenticateClient(c: Context<AppEnv>, body: Params, now: number): Promise<OAuthClient | Response> {
  let id = body.client_id ?? "", secret = body.client_secret ?? "";
  const authorization = c.req.header("authorization");
  const basic = /^Basic(?:\s|$)/i.test(authorization ?? "");
  if (basic) {
    try {
      const value = atob(authorization!.replace(/^Basic\s+/i, ""));
      const colon = value.indexOf(":");
      if (colon < 0) throw new Error("invalid basic");
      const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
      id = decode(value.slice(0, colon));
      secret = decode(value.slice(colon + 1));
    } catch { return error(c, "invalid_client", undefined, true); }
  }
  const client = await resolveClient(c.env, c.env.DB, id, now);
  if (!client || (client.auth_method !== "none" && (!secret || await hashToken(secret) !== client.secret_hash))) return error(c, "invalid_client", undefined, basic);
  return client;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface CodeRow {
  code_hash: string; client_id: string; redirect_uri: string; code_challenge: string;
  user_id: string; workspace_id: string; scope: ApiTokenScope; resource: string | null;
  expires_at: number; used_at: number | null; grant_id: string | null;
}

function success(c: Context<AppEnv>, access: string, refresh: string, scope: ApiTokenScope): Response {
  return c.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: scope === "write" ? "read write" : "read" });
}

export async function issueToken(c: Context<AppEnv>): Promise<Response> {
  c.header("Pragma", "no-cache");
  const body = await readParams(c);
  if (!body) return error(c, "invalid_request");
  const now = Date.now(), db = c.env.DB;
  const client = await authenticateClient(c, body, now);
  if (client instanceof Response) return client;
  if (!body.grant_type) return error(c, "invalid_request");
  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier) return error(c, "invalid_request");
    const code = await first<CodeRow>(db, "SELECT * FROM oauth_codes WHERE code_hash = ?", await hashToken(body.code));
    if (!code || code.expires_at <= now) return error(c, "invalid_grant");
    if (code.used_at !== null) {
      if (code.grant_id) await deleteGrant(db, code.grant_id);
      return error(c, "invalid_grant");
    }
    if (code.client_id !== client.client_id || (body.redirect_uri !== undefined && body.redirect_uri !== code.redirect_uri)
      || !PKCE_RE.test(body.code_verifier) || await pkceChallenge(body.code_verifier) !== code.code_challenge) return error(c, "invalid_grant");
    if (body.resource !== undefined && !isAllowedResource(body.resource, publicOrigin(c))) return error(c, "invalid_target");
    if (!await isGrantMember(db, code.workspace_id, code.user_id)) return error(c, "invalid_grant");
    const id = crypto.randomUUID(), access = "sen_at_" + randomToken(32), refresh = "sen_rt_" + randomToken(32);
    // コードの消費と発行を同じトランザクションにまとめ、競合時の孤立した接続を防ぐ
    const results = await db.batch([
      stmt(db, "UPDATE oauth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ? AND used_at IS NULL", now, id, code.code_hash),
      stmt(db, `INSERT INTO oauth_grants (id, client_id, workspace_id, user_id, scope, client_name, refresh_hash, prev_refresh_hash, refresh_expires_at, created_at, last_used_at)
        SELECT ?, client_id, workspace_id, user_id, scope, ?, ?, NULL, ?, ?, NULL FROM oauth_codes WHERE code_hash = ? AND grant_id = ?`, id, client.name, await hashToken(refresh), now + REFRESH_LIFETIME, now, code.code_hash, id),
      stmt(db, "INSERT INTO oauth_access_tokens (token_hash, grant_id, expires_at) SELECT ?, id, ? FROM oauth_grants WHERE id = ?", await hashToken(access), now + 3_600_000, id),
    ]);
    if (!results[0].meta.changes) return error(c, "invalid_grant");
    return success(c, access, refresh, code.scope);
  }
  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return error(c, "invalid_request");
    const hash = await hashToken(body.refresh_token);
    const grant = await first<GrantRow>(db, "SELECT * FROM oauth_grants WHERE refresh_hash = ? OR prev_refresh_hash = ?", hash, hash);
    if (!grant || grant.client_id !== client.client_id || grant.refresh_expires_at <= now) return error(c, "invalid_grant");
    if (!await isGrantMember(db, grant.workspace_id, grant.user_id)) {
      await deleteGrant(db, grant.id);
      return error(c, "invalid_grant");
    }
    if (body.resource !== undefined && !isAllowedResource(body.resource, publicOrigin(c))) return error(c, "invalid_target");
    const access = "sen_at_" + randomToken(32), refresh = "sen_rt_" + randomToken(32);
    const newHash = await hashToken(refresh);
    const prev = grant.refresh_hash === hash ? grant.refresh_hash : grant.prev_refresh_hash;
    const results = await db.batch([
      stmt(db, "UPDATE oauth_grants SET refresh_hash = ?, prev_refresh_hash = ?, refresh_expires_at = ? WHERE id = ? AND refresh_hash = ? AND prev_refresh_hash IS ?", newHash, prev, now + REFRESH_LIFETIME, grant.id, grant.refresh_hash, grant.prev_refresh_hash),
      stmt(db, "INSERT INTO oauth_access_tokens (token_hash, grant_id, expires_at) SELECT ?, id, ? FROM oauth_grants WHERE id = ? AND refresh_hash = ?", await hashToken(access), now + 3_600_000, grant.id, newHash),
      stmt(db, "DELETE FROM oauth_access_tokens WHERE grant_id = ? AND expires_at <= ?", grant.id, now),
    ]);
    if (!results[0].meta.changes) return error(c, "invalid_grant");
    return success(c, access, refresh, grant.scope);
  }
  return error(c, "unsupported_grant_type", "この grant_type は利用できません");
}

/** 未知のトークンでも成功を返し、存在するトークンの情報を漏らさない */
export async function revokeToken(c: Context<AppEnv>): Promise<Response> {
  c.header("Pragma", "no-cache");
  const body = await readParams(c);
  if (!body) return error(c, "invalid_request");
  const client = await authenticateClient(c, body, Date.now());
  if (client instanceof Response) return client;
  if (!body.token) return error(c, "invalid_request");
  const hash = await hashToken(body.token);
  const grant = await first<{ id: string }>(c.env.DB, `SELECT g.id FROM oauth_grants g WHERE g.client_id = ? AND (g.refresh_hash = ? OR g.prev_refresh_hash = ? OR EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.grant_id = g.id AND a.token_hash = ?))`, client.client_id, hash, hash, hash);
  if (grant) await deleteGrant(c.env.DB, grant.id);
  return c.json({});
}
