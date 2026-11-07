import type { Env } from "../env";
import { originOf } from "../tokens";

/** SPA に渡さず、MCP の保護リソースと認可サーバーを公開する */
export function handleWellKnown(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const origin = originOf(env, request.url);
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=300",
    "Content-Type": "application/json",
  };
  const respond = (body: unknown, status = 200) => new Response(
    request.method === "HEAD" ? null : JSON.stringify(body), { status, headers },
  );
  const protectedResource = ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"].includes(url.pathname);
  if (!protectedResource && url.pathname !== "/.well-known/oauth-authorization-server") return respond({ error: "not_found" }, 404);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...headers, Allow: "GET, HEAD, OPTIONS" } });
  }
  if (protectedResource) {
    return respond({ resource: `${origin}/api/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_name: "Sen" });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return respond({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      revocation_endpoint: `${origin}/api/oauth/revoke`,
      response_types_supported: ["code"], response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: ["read", "write"], client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  }
  return respond({ error: "not_found" }, 404);
}

/** URL の正規化後に、このサーバーの MCP だけを対象として認める */
export function isAllowedResource(resource: string, origin: string): boolean {
  try {
    const normalized = new URL(resource).href;
    return [origin, `${origin}/`, `${origin}/api/mcp`, `${origin}/api/mcp/`]
      .some((candidate) => new URL(candidate).href === normalized);
  } catch { return false; }
}
