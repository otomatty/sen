import { DurableObject } from "cloudflare:workers";
import { addDays, todayYmd } from "../shared/dates";
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

  /** 毎日の掃除：30日より古い同期ログ、期限切れから30日経った API トークン、期限切れのセッション・ログイン途中のデータ、古い招待と、7 日より前の AI アシスタントの利用回数を削除する */
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
    // 期限が切れてから 30 日以上たった API トークン（無期限のものは残す）
    await run(env.DB, "DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?", cutoff);
    // Better Auth は日時を ISO 8601 の文字列で保存するので、文字列のまま比べられる
    const now = new Date().toISOString();
    await run(env.DB, "DELETE FROM auth_sessions WHERE expires_at < ?", now);
    await run(env.DB, "DELETE FROM auth_verifications WHERE expires_at < ?", now);
    // 期限から 30 日以上たった未承諾の招待と、取り消してから 30 日以上たった招待。
    // 承諾済みは「誰が誰を招待したか」の記録として残す
    await run(env.DB, "DELETE FROM invitations WHERE accepted_at IS NULL AND expires_at < ?", cutoff);
    await run(
      env.DB,
      "DELETE FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NOT NULL AND revoked_at < ?",
      cutoff,
    );
    // 7日より前の利用回数（日本時間の日付。YYYY-MM-DD なので文字列の比較で足りる）
    await run(env.DB, "DELETE FROM assistant_usage WHERE day < ?", addDays(todayYmd(), -7));
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

  /**
   * 以前のスプレッドシート連携が予約したアラームが残っていたときだけ呼ばれる。
   * 連携の状態（キー "sheets"）を消すだけで、次の予約はしない。
   */
  async alarm() {
    await this.ctx.storage.delete("sheets");
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
