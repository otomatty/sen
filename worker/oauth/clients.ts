import type { Context } from "hono";
import { randomToken } from "../auth";
import { first, run } from "../db";
import type { AppEnv, Env } from "../env";
import { hashToken } from "../tokens";

export interface OAuthClient {
  client_id: string;
  kind: "dcr" | "cimd";
  name: string;
  redirect_uris: string;
  auth_method: "none" | "client_secret_post" | "client_secret_basic";
  secret_hash: string | null;
  created_at: number;
  fetched_at: number | null;
}

export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Web とネイティブアプリの戻り先を認め、実行可能な危険なスキームは除く */
export function isAllowedRedirectUri(s: string): boolean {
  if (!s || s.length > 2000 || s.includes("#")) return false;
  try {
    const u = new URL(s);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return isLoopback(u);
    return !["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:", "ws:", "wss:", "ftp:", "mailto:", "tel:"].includes(u.protocol);
  } catch { return false; }
}

/** ループバックのみ、ネイティブアプリが選ぶ一時ポートを許可する */
export function matchRedirectUri(registered: string[], requested: string): boolean {
  if (!isAllowedRedirectUri(requested)) return false;
  return registered.some((s) => {
    if (s === requested) return true;
    try {
      const a = new URL(s), b = new URL(requested);
      return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
    } catch { return false; }
  });
}

export function cleanClientName(raw: unknown, fallback = "AI ツール"): string {
  if (typeof raw !== "string") return fallback;
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim()).slice(0, 40).join("") || fallback;
}

function validRedirects(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 10
    && value.every((s) => typeof s === "string" && isAllowedRedirectUri(s));
}

/** サイズ制限は Content-Length に頼らず、ストリームにも適用する */
async function limitedJson(response: Response | Request, limit: number): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("body too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid JSON");
  return data as Record<string, unknown>;
}

/** 公開クライアントを既定にした動的登録。秘密はハッシュだけ保存する */
export async function registerClient(c: Context<AppEnv>): Promise<Response> {
  const error = (error: string) => c.json({ error, error_description: "クライアントの登録情報が不正です" }, 400);
  let body: Record<string, unknown>;
  try { body = await limitedJson(c.req.raw, 16 * 1024); } catch { return error("invalid_client_metadata"); }
  if (!validRedirects(body.redirect_uris)) return error("invalid_redirect_uri");
  const method = body.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") return error("invalid_client_metadata");
  if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || !body.grant_types.includes("authorization_code") || body.grant_types.some((v) => v !== "authorization_code" && v !== "refresh_token"))) return error("invalid_client_metadata");
  if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code")) return error("invalid_client_metadata");
  const id = "sen_client_" + randomToken(16);
  const secret = method === "none" ? null : "sen_cs_" + randomToken(32);
  const name = cleanClientName(body.client_name);
  const now = Date.now();
  await run(c.env.DB, `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, auth_method, secret_hash, created_at, fetched_at) VALUES (?, 'dcr', ?, ?, ?, ?, ?, NULL)`, id, name, JSON.stringify(body.redirect_uris), method, secret ? await hashToken(secret) : null, now);
  return c.json({ client_id: id, client_id_issued_at: Math.floor(now / 1000), client_name: name,
    redirect_uris: body.redirect_uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: method,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
  }, 201);
}

/** CIMD はリダイレクトを追わず取得する。障害時は以前に検証したキャッシュを使う */
export async function resolveClient(env: Env, db: D1Database, clientId: string, now: number): Promise<OAuthClient | null> {
  const cimd = clientId.startsWith("https://") || (env.DEV_TOOLS === "1" && /^http:\/\/(localhost|127\.0\.0\.1):/.test(clientId));
  if (!cimd) return first<OAuthClient>(db, "SELECT * FROM oauth_clients WHERE client_id = ? AND kind = 'dcr'", clientId);
  let url: URL;
  try {
    url = new URL(clientId);
    if (clientId.length > 2000 || url.pathname === "/" || clientId.includes("#") || url.username || url.password) return null;
  } catch { return null; }
  const cached = await first<OAuthClient>(db, "SELECT * FROM oauth_clients WHERE client_id = ? AND kind = 'cimd'", clientId);
  if (cached?.fetched_at != null && now - cached.fetched_at < 86_400_000) return cached;
  try {
    const response = await fetch(clientId, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) { await response.body?.cancel(); return cached; }
    const body = await limitedJson(response, 10 * 1024);
    if (body.client_id !== clientId || !validRedirects(body.redirect_uris) || (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none")) return cached;
    const client: OAuthClient = { client_id: clientId, kind: "cimd", name: cleanClientName(body.client_name, url.hostname), redirect_uris: JSON.stringify(body.redirect_uris), auth_method: "none", secret_hash: null, created_at: cached?.created_at ?? now, fetched_at: now };
    await run(db, `INSERT INTO oauth_clients (client_id, kind, name, redirect_uris, auth_method, secret_hash, created_at, fetched_at) VALUES (?, 'cimd', ?, ?, 'none', NULL, ?, ?) ON CONFLICT(client_id) DO UPDATE SET kind = 'cimd', name = excluded.name, redirect_uris = excluded.redirect_uris, auth_method = 'none', secret_hash = NULL, fetched_at = excluded.fetched_at`, clientId, client.name, client.redirect_uris, client.created_at, now);
    return client;
  } catch { return cached; }
}
