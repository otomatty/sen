import { DurableObject } from "cloudflare:workers";
import { createApp } from "./app";
import { all, ensureMigrated, run } from "./db";
import type { Env } from "./env";

const app = createApp();

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    // /api 以外は静的アセット（SPA）。run_worker_first の設定上ここには通常来ない。
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },

  /** 毎日の掃除：30日より古い同期ログと、期限切れのセッション・ログイン途中のデータを削除する */
  async scheduled(_event, env) {
    await ensureMigrated(env.DB);
    const cutoff = Date.now() - 30 * 86_400_000;
    const rows = await all<{ workspace_id: string; m: number }>(
      env.DB,
      "SELECT workspace_id, MAX(id) AS m FROM sync_log WHERE created_at < ? GROUP BY workspace_id",
      cutoff,
    );
    for (const r of rows) {
      await run(
        env.DB,
        `INSERT INTO sync_meta (workspace_id, pruned_before) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET pruned_before = excluded.pruned_before`,
        r.workspace_id,
        r.m,
      );
      await run(env.DB, "DELETE FROM sync_log WHERE workspace_id = ? AND id <= ?", r.workspace_id, r.m);
    }
    // Better Auth は日時を ISO 8601 の文字列で保存するので、文字列のまま比べられる
    const now = new Date().toISOString();
    await run(env.DB, "DELETE FROM auth_sessions WHERE expires_at < ?", now);
    await run(env.DB, "DELETE FROM auth_verifications WHERE expires_at < ?", now);
  },
} satisfies ExportedHandler<Env>;

/**
 * ワークスペースごとのリアルタイム通知。
 * 変更内容そのものは送らず「新しい syncId がある」ことだけを知らせ、
 * クライアントは /api/sync で差分を取りに行く（Linear の同期エンジンと同じ考え方）。
 * Hibernation API を使うので、接続が待機中の間は課金されない。
 */
export class WorkspaceRealtime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/notify" && request.method === "POST") {
      const { lastSyncId } = (await request.json()) as { lastSyncId: number };
      const msg = JSON.stringify({ type: "sync", lastSyncId });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
        } catch {
          // 切断済みのソケットは無視
        }
      }
      return new Response("ok");
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "hello", connections: this.ctx.getWebSockets().length }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // noop
    }
  }
}
