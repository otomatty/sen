import { DurableObject } from "cloudflare:workers";
import { createApp } from "./app";
import { all, ensureMigrated, first, run } from "./db";
import type { Env, WorkspaceRow } from "./env";
import { requestSheetSyncNow, sheetsConfig } from "./sheets/config";
import { SheetSyncRunner } from "./sheets/runner";

const app = createApp();

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    // /api 以外は静的アセット（SPA）。run_worker_first の設定上ここには通常来ない。
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },

  /** 毎日の掃除：30日より古い同期ログ、期限切れから30日経った API トークン、期限切れのセッション・ログイン途中のデータ、古い招待を削除する */
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
    // スプレッドシートへ反映する（期限の超過など日付で変わる値の更新と、失敗した分のやり直し）。
    // ここで失敗しても、上の掃除はすでに終わっている。
    try {
      await syncSheets(env);
    } catch (e) {
      console.error("sheets cron failed", e);
    }
  },
} satisfies ExportedHandler<Env>;

/** 連携が有効なときだけ、対象ワークスペースの Durable Object に今すぐ反映を頼む */
async function syncSheets(env: Env): Promise<void> {
  const cfg = sheetsConfig(env);
  if (!cfg) return;
  const ws = await first<WorkspaceRow>(env.DB, "SELECT * FROM workspaces WHERE url_key = ?", cfg.workspaceKey);
  if (!ws) {
    console.error("SHEETS_WORKSPACE のワークスペースが見つかりません");
    return;
  }
  // 公開 URL が設定されていればそれを渡す。無ければ Durable Object が保存している origin を使う。
  const origin = env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "") ?? "";
  await requestSheetSyncNow(env, ws.id, origin);
}

/**
 * ワークスペースごとのリアルタイム通知。
 * 変更内容そのものは送らず「新しい syncId がある」ことだけを知らせ、
 * クライアントは /api/sync で差分を取りに行く（Linear の同期エンジンと同じ考え方）。
 * Hibernation API を使うので、接続が待機中の間は課金されない。
 */
export class WorkspaceRealtime extends DurableObject<Env> {
  private sheets: SheetSyncRunner;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sheets = new SheetSyncRunner(ctx.storage, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const r = await this.sheets.handle(request);
    if (r) return r;
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

  async alarm() {
    await this.sheets.alarm();
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
