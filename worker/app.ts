import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { BootstrapPayload, MutateRequest, MutateResponse, Mutation, Role } from "../shared/types";
import { getAuth, getSessionUser, isGoogleConfigured } from "./auth";
import { all, ensureMigrated, first, run } from "./db";
import type { AppEnv, WorkspaceRow } from "./env";
import { applyMutation, MutationError, type MutationCtx } from "./mutations";
import { createWorkspace, seedDemo } from "./seed";
import {
  toActivity,
  toComment,
  toCycle,
  toIssue,
  toLabel,
  toNotification,
  toProject,
  toState,
  toTeam,
  toUser,
  toWorkspace,
} from "./serialize";
import { getLastSyncId, notifyRealtime, readChanges, writeChanges } from "./sync";

function err(c: Context, message: string, status = 400) {
  return c.json({ error: message }, status as 400);
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  app.onError((e, c) => {
    if (e instanceof MutationError) return err(c, e.message, e.status);
    console.error(e);
    return err(c, "サーバーでエラーが発生しました", 500);
  });

  // DB の準備 + CSRF 対策（状態を変えるリクエストには独自ヘッダーを必須にする）
  app.use("*", async (c, next) => {
    await ensureMigrated(c.env.DB);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-sen-client") !== "1") {
      return err(c, "不正なリクエストです", 403);
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
    const user = await getSessionUser(c);
    if (!user) return err(c, "ログインが必要です", 401);
    c.set("user", user);
    await next();
  };

  const requireWorkspace: MiddlewareHandler<AppEnv> = async (c, next) => {
    const key = c.req.query("ws");
    if (!key) return err(c, "ワークスペースを指定してください");
    const ws = await first<WorkspaceRow>(c.env.DB, "SELECT * FROM workspaces WHERE url_key = ?", key);
    if (!ws) return err(c, "ワークスペースが見つかりません", 404);
    const m = await first<{ role: Role }>(
      c.env.DB,
      "SELECT role FROM members WHERE workspace_id = ? AND user_id = ?",
      ws.id,
      c.get("user").id,
    );
    if (!m) return err(c, "このワークスペースへのアクセス権がありません", 403);
    c.set("workspace", ws);
    c.set("role", m.role);
    await next();
  };

  const listWorkspaces = (c: Context<AppEnv>, userId: string) =>
    all<{ id: string; name: string; url_key: string }>(
      c.env.DB,
      `SELECT w.id, w.name, w.url_key FROM workspaces w JOIN members m ON m.workspace_id = w.id
       WHERE m.user_id = ? ORDER BY m.created_at`,
      userId,
    ).then((rows) => rows.map((r) => ({ id: r.id, name: r.name, urlKey: r.url_key })));

  app.get("/health", (c) => c.json({ ok: true, devTools: c.env.DEV_TOOLS === "1" }));

  // ---------------- 認証（Google のみ。Better Auth） ----------------
  app.post("/auth/sign-in/social", async (c, next) => {
    if (!isGoogleConfigured(c.env)) {
      return err(c, "Google ログインが設定されていません（GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してください）", 503);
    }
    await next();
  });
  app.on(["GET", "POST"], "/auth/*", (c) => getAuth(c).handler(c.req.raw));

  app.get("/me", async (c) => {
    const user = await getSessionUser(c);
    if (!user) return c.json({ user: null, workspaces: [] });
    return c.json({ user, workspaces: await listWorkspaces(c, user.id) });
  });

  // ---------------- ワークスペース ----------------
  app.post("/workspaces", requireUser, async (c) => {
    const body = await readJson<{ name?: string }>(c);
    const name = (body.name ?? "").trim();
    if (!name || name.length > 60) return err(c, "ワークスペース名を60文字以内で入力してください");
    const ws = await createWorkspace(c.env.DB, { name, ownerId: c.get("user").id });
    return c.json({ ok: true, workspaceKey: ws.urlKey });
  });

  app.get("/invite/:code", async (c) => {
    const ws = await first<WorkspaceRow>(c.env.DB, "SELECT * FROM workspaces WHERE invite_code = ?", c.req.param("code"));
    if (!ws) return err(c, "招待リンクが無効です", 404);
    const count = await first<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM members WHERE workspace_id = ?", ws.id);
    return c.json({ name: ws.name, urlKey: ws.url_key, memberCount: count?.c ?? 0 });
  });

  app.post("/invite/:code/accept", requireUser, async (c) => {
    const ws = await first<WorkspaceRow>(c.env.DB, "SELECT * FROM workspaces WHERE invite_code = ?", c.req.param("code"));
    if (!ws) return err(c, "招待リンクが無効です", 404);
    const user = c.get("user");
    await run(
      c.env.DB,
      "INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
      ws.id,
      user.id,
      Date.now(),
    );
    const last = await writeChanges(c.env.DB, ws.id, [{ entity: "user", entityId: user.id, op: "upsert" }]);
    c.executionCtx?.waitUntil?.(notifyRealtime(c.env, ws.id, last));
    return c.json({ ok: true, workspaceKey: ws.url_key });
  });

  // ---------------- 同期 ----------------
  app.get("/bootstrap", requireUser, requireWorkspace, async (c) => {
    const db = c.env.DB;
    const ws = c.get("workspace");
    const user = c.get("user");
    // 先に syncId を取ってから読む（読んでいる間の変更は次の差分取得で拾える）
    const lastSyncId = await getLastSyncId(db, ws.id);
    const [users, teams, states, labels, projects, cycles, issues, notifications, workspaces] = await Promise.all([
      all<never>(db, "SELECT u.*, m.role FROM users u JOIN members m ON m.user_id = u.id WHERE m.workspace_id = ? ORDER BY m.created_at", ws.id),
      all<never>(db, "SELECT * FROM teams WHERE workspace_id = ? ORDER BY created_at", ws.id),
      all<never>(db, "SELECT * FROM workflow_states WHERE workspace_id = ?", ws.id),
      all<never>(db, "SELECT * FROM labels WHERE workspace_id = ? ORDER BY name", ws.id),
      all<never>(db, "SELECT * FROM projects WHERE workspace_id = ? AND archived_at IS NULL", ws.id),
      all<never>(db, "SELECT * FROM cycles WHERE workspace_id = ?", ws.id),
      all<never>(db, "SELECT * FROM issues WHERE workspace_id = ?", ws.id),
      all<never>(
        db,
        "SELECT * FROM notifications WHERE workspace_id = ? AND user_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 500",
        ws.id,
        user.id,
      ),
      listWorkspaces(c, user.id),
    ]);
    const payload: BootstrapPayload = {
      me: { ...user, role: c.get("role") },
      workspace: toWorkspace(ws),
      workspaces,
      users: users.map(toUser),
      teams: teams.map(toTeam),
      states: states.map(toState),
      labels: labels.map(toLabel),
      projects: projects.map(toProject),
      cycles: cycles.map(toCycle),
      issues: issues.map(toIssue),
      notifications: notifications.map(toNotification),
      lastSyncId,
    };
    return c.json(payload);
  });

  app.get("/sync", requireUser, requireWorkspace, async (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const limit = 2000;
    // 先に全体の最新 ID を取る（読み取り中に増えた分は次回拾う）。
    // 他ユーザー宛ての行しか無い場合でも lastSyncId を進められるよう、全体の最大値を返す。
    const meta = await first<{ pruned_before: number }>(
      c.env.DB,
      "SELECT pruned_before FROM sync_meta WHERE workspace_id = ?",
      c.get("workspace").id,
    );
    if (meta && after < meta.pruned_before) {
      // 必要な差分がすでに掃除されている → 全体を読み込み直してもらう
      return c.json({ changes: [], lastSyncId: after, hasMore: false, reset: true });
    }
    const globalLast = await getLastSyncId(c.env.DB, c.get("workspace").id);
    const changes = await readChanges(c.env.DB, c.get("workspace").id, c.get("user").id, after, limit);
    const hasMore = changes.length === limit;
    const lastSyncId = hasMore ? changes[changes.length - 1].id : Math.max(globalLast, changes.at(-1)?.id ?? 0, after);
    return c.json({ changes, lastSyncId, hasMore });
  });

  app.get("/issues/:id/thread", requireUser, requireWorkspace, async (c) => {
    const id = c.req.param("id");
    const ws = c.get("workspace");
    const issue = await first(c.env.DB, "SELECT id FROM issues WHERE id = ? AND workspace_id = ?", id, ws.id);
    if (!issue) return err(c, "課題が見つかりません", 404);
    const [comments, activities] = await Promise.all([
      all<never>(c.env.DB, "SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at", id),
      all<never>(c.env.DB, "SELECT * FROM activities WHERE issue_id = ? ORDER BY created_at", id),
    ]);
    return c.json({ comments: comments.map(toComment), activities: activities.map(toActivity) });
  });

  app.post("/mutate", requireUser, requireWorkspace, async (c) => {
    const body = await readJson<MutateRequest>(c);
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [];
    const ctx: MutationCtx = {
      db: c.env.DB,
      ws: c.get("workspace"),
      user: c.get("user"),
      role: c.get("role"),
      now: Date.now(),
      changes: [],
    };
    const results: MutateResponse["results"] = [];
    for (const op of ops) {
      try {
        ctx.now = Date.now();
        await applyMutation(ctx, op.mutation as Mutation);
        results.push({ clientId: op.clientId, ok: true });
      } catch (e) {
        if (e instanceof MutationError) results.push({ clientId: op.clientId, ok: false, error: e.message });
        else {
          console.error(e);
          results.push({ clientId: op.clientId, ok: false, error: "サーバーでエラーが発生しました" });
        }
      }
    }
    const lastSyncId = await writeChanges(c.env.DB, ctx.ws.id, ctx.changes);
    if (ctx.changes.length) c.executionCtx?.waitUntil?.(notifyRealtime(c.env, ctx.ws.id, lastSyncId));
    return c.json({ results, lastSyncId } satisfies MutateResponse);
  });

  // ---------------- リアルタイム（Durable Object へ転送） ----------------
  app.get("/realtime", requireUser, requireWorkspace, async (c) => {
    if (!c.env.REALTIME) return err(c, "リアルタイム同期は無効です", 501);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return err(c, "WebSocket が必要です", 426);
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(c.get("workspace").id));
    return stub.fetch(new Request("https://realtime/connect", c.req.raw));
  });

  // ---------------- 開発用 ----------------
  app.post("/dev/seed-demo", requireUser, requireWorkspace, async (c) => {
    if (c.env.DEV_TOOLS !== "1") return err(c, "無効です", 404);
    if (c.get("role") !== "admin") return err(c, "管理者のみ実行できます", 403);
    await seedDemo(c.env.DB, c.get("workspace").id, c.get("user").id);
    const last = await getLastSyncId(c.env.DB, c.get("workspace").id);
    return c.json({ ok: true, lastSyncId: last });
  });

  app.all("*", (c) => err(c, "見つかりません", 404));

  return app;
}
