import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ApiTokenScope, OAuthConsentInfo, OAuthRedirectResponse } from "../../shared/types";
import { randomToken } from "../auth";
import { first, run, stmt } from "../db";
import type { AppEnv } from "../env";
import { hashToken, publicOrigin } from "../tokens";
import { isLoopback, matchRedirectUri, resolveClient } from "./clients";
import { isGrantMember } from "./grants";
import { isAllowedResource } from "./metadata";

interface RequestRow {
  id: string; client_id: string; redirect_uri: string; state: string | null; code_challenge: string;
  scope: ApiTokenScope; resource: string | null; created_at: number; expires_at: number;
}
export const PKCE_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const EXPIRED = "この接続のリクエストは期限が切れています。AI ツールからもう一度接続してください。";

/** 独自スキームにも URL を使い、state と issuer を安全に付ける */
export function redirectTo(uri: string, state: string | null, origin: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", origin);
  return url.href;
}

export async function authorize(c: Context<AppEnv>): Promise<Response> {
  const q = c.req.query(), now = Date.now(), origin = publicOrigin(c);
  const client = await resolveClient(c.env, c.env.DB, q.client_id ?? "", now);
  if (!client) return c.redirect("/oauth/consent?error=invalid_client", 302);
  const registered = JSON.parse(client.redirect_uris) as string[];
  const uri = q.redirect_uri ?? (registered.length === 1 ? registered[0] : "");
  if (!uri || !matchRedirectUri(registered, uri)) return c.redirect("/oauth/consent?error=invalid_redirect", 302);
  const state = q.state ?? null;
  const fail = (error: string) => c.redirect(redirectTo(uri, state, origin, { error }), 302);
  if (q.response_type !== "code") return fail("unsupported_response_type");
  if (!PKCE_RE.test(q.code_challenge ?? "") || q.code_challenge_method !== "S256" || (state?.length ?? 0) > 2000) return fail("invalid_request");
  if (q.resource !== undefined && !isAllowedResource(q.resource, origin)) return fail("invalid_target");
  const scopes = (q.scope ?? "").split(/\s+/);
  const scope = scopes.includes("write") || !scopes.includes("read") ? "write" : "read";
  const id = randomToken(32);
  await run(c.env.DB, `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, client.client_id, uri, state, q.code_challenge, scope, q.resource ?? null, now, now + 600_000);
  return c.redirect(`/oauth/consent?request=${id}`, 302);
}

function destination(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === "https:") return url.hostname;
  if (isLoopback(url)) return `このパソコン（${url.hostname}）`;
  return `${url.protocol}// のアプリ`;
}

type WorkspaceList = (c: Context<AppEnv>, userId: string, email: string) => Promise<{ id: string; name: string; urlKey: string }[]>;

/** 同意の API は既存の Cookie 認証・所属ワークスペースの条件を使う */
export function registerAuthorization(app: Hono<AppEnv>, requireUser: MiddlewareHandler<AppEnv>, listWorkspaces: WorkspaceList): void {
  const load = (c: Context<AppEnv>) => first<RequestRow>(c.env.DB, "SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?", c.req.param("id") ?? "", Date.now());
  app.get("/oauth/authorize", authorize);
  app.get("/oauth/requests/:id", requireUser, async (c) => {
    const request = await load(c);
    if (!request) return c.json({ error: EXPIRED }, 404);
    const client = await resolveClient(c.env, c.env.DB, request.client_id, Date.now());
    if (!client) return c.json({ error: EXPIRED }, 404);
    const user = c.get("user");
    const workspaces = await listWorkspaces(c, user.id, user.email);
    const stored = await first<{ default_workspace_id: string | null }>(c.env.DB, "SELECT default_workspace_id FROM users WHERE id = ?", user.id);
    const body: OAuthConsentInfo = {
      clientName: client.name, destination: destination(request.redirect_uri),
      verifiedHost: client.kind === "cimd" ? new URL(client.client_id).hostname : null,
      scope: request.scope, workspaces,
      defaultWorkspaceId: workspaces.some((w) => w.id === stored?.default_workspace_id) ? stored!.default_workspace_id : null,
    };
    return c.json(body);
  });
  app.post("/oauth/requests/:id/approve", requireUser, async (c) => {
    const request = await load(c);
    if (!request) return c.json({ error: EXPIRED }, 404);
    let body: { workspaceId?: unknown; scope?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "不正なリクエストです" }, 400); }
    if (!body || (body.scope !== "read" && body.scope !== "write")) return c.json({ error: "権限が不正です" }, 400);
    const user = c.get("user");
    const workspaces = await listWorkspaces(c, user.id, user.email);
    const workspaceId = body.workspaceId;
    if (typeof workspaceId !== "string" || !workspaces.some((w) => w.id === workspaceId) || !await isGrantMember(c.env.DB, workspaceId, user.id)) return c.json({ error: "このワークスペースには参加していません" }, 403);
    const code = randomToken(32), now = Date.now();
    // 作成と消費を同じトランザクションにし、同意の二重送信を防ぐ
    const results = await c.env.DB.batch([
      stmt(c.env.DB, `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, workspace_id, scope, resource, created_at, expires_at)
        SELECT ?, client_id, redirect_uri, code_challenge, ?, ?, ?, resource, ?, ? FROM oauth_requests WHERE id = ? AND expires_at > ?`, await hashToken(code), user.id, workspaceId, body.scope, now, now + 300_000, request.id, now),
      stmt(c.env.DB, "DELETE FROM oauth_requests WHERE id = ?", request.id),
    ]);
    if (!results[0].meta.changes) return c.json({ error: EXPIRED }, 404);
    return c.json({ redirectTo: redirectTo(request.redirect_uri, request.state, publicOrigin(c), { code }) } satisfies OAuthRedirectResponse);
  });
  app.post("/oauth/requests/:id/deny", requireUser, async (c) => {
    const request = await first<RequestRow>(c.env.DB, "DELETE FROM oauth_requests WHERE id = ? AND expires_at > ? RETURNING *", c.req.param("id") ?? "", Date.now());
    if (!request) return c.json({ error: EXPIRED }, 404);
    return c.json({ redirectTo: redirectTo(request.redirect_uri, request.state, publicOrigin(c), { error: "access_denied" }) } satisfies OAuthRedirectResponse);
  });
}
