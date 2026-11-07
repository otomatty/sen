import type { Context } from "hono";
import type { AppEnv } from "../env";

/** Cookie を使わない API にだけ、外部ツールからのアクセスを許可する */
export function applyOAuthCors(c: Context<AppEnv>): Response | null {
  const mcp = c.req.path === "/api/mcp";
  const oauth = ["/api/oauth/token", "/api/oauth/register", "/api/oauth/revoke"].includes(c.req.path);
  if (!mcp && !oauth) return null;
  c.header("Access-Control-Allow-Origin", "*");
  if (mcp) c.header("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  if (c.req.method !== "OPTIONS") return null;
  c.header("Access-Control-Allow-Methods", mcp ? "POST, GET, DELETE, OPTIONS" : "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", mcp
    ? "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID"
    : "Authorization, Content-Type, Accept");
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
}
