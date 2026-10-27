import type { EntityName } from "../shared/types";
import { all, batch, first, stmt } from "./db";
import type { Env } from "./env";
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

export interface Change {
  entity: EntityName;
  entityId: string;
  op: "upsert" | "delete";
  /** 省略時は DB から読み直して書き出す */
  data?: unknown;
  /** 特定ユーザーにだけ配信する変更（通知など） */
  userId?: string | null;
}

const TABLE: Record<Exclude<EntityName, "user" | "workspace">, [string, (r: never) => unknown]> = {
  team: ["teams", toTeam as never],
  state: ["workflow_states", toState as never],
  label: ["labels", toLabel as never],
  project: ["projects", toProject as never],
  cycle: ["cycles", toCycle as never],
  issue: ["issues", toIssue as never],
  comment: ["comments", toComment as never],
  activity: ["activities", toActivity as never],
  notification: ["notifications", toNotification as never],
};

export async function loadEntity(db: D1Database, workspaceId: string, entity: EntityName, id: string) {
  if (entity === "workspace") {
    const r = await first<never>(db, "SELECT * FROM workspaces WHERE id = ?", id);
    return r ? toWorkspace(r) : null;
  }
  if (entity === "user") {
    const r = await first<Record<string, unknown>>(
      db,
      "SELECT u.*, m.role FROM users u JOIN members m ON m.user_id = u.id AND m.workspace_id = ? WHERE u.id = ?",
      workspaceId,
      id,
    );
    return r ? toUser(r) : null;
  }
  const [table, fn] = TABLE[entity];
  const r = await first<never>(db, `SELECT * FROM ${table} WHERE id = ?`, id);
  return r ? fn(r) : null;
}

/** 変更を同期ログに書き込み、最新の syncId を返す */
export async function writeChanges(db: D1Database, workspaceId: string, changes: Change[]): Promise<number> {
  if (changes.length) {
    // 同じエンティティへの連続した upsert は最後の 1 件にまとめる
    const deduped: Change[] = [];
    const seen = new Map<string, number>();
    for (const ch of changes) {
      const key = `${ch.entity}:${ch.entityId}:${ch.userId ?? ""}`;
      const idx = seen.get(key);
      if (idx !== undefined && ch.op === "upsert" && deduped[idx].op === "upsert" && ch.data === undefined) {
        continue;
      }
      seen.set(key, deduped.length);
      deduped.push(ch);
    }
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (const ch of deduped) {
      let data: unknown = ch.data;
      if (ch.op === "upsert" && data === undefined) {
        data = await loadEntity(db, workspaceId, ch.entity, ch.entityId);
        if (data === null) continue;
      }
      statements.push(
        stmt(
          db,
          "INSERT INTO sync_log (workspace_id, entity, entity_id, op, data, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          workspaceId,
          ch.entity,
          ch.entityId,
          ch.op,
          data === undefined ? null : JSON.stringify(data),
          ch.userId ?? null,
          now,
        ),
      );
    }
    await batch(db, statements);
  }
  return getLastSyncId(db, workspaceId);
}

export async function getLastSyncId(db: D1Database, workspaceId: string): Promise<number> {
  const r = await first<{ m: number | null }>(db, "SELECT MAX(id) AS m FROM sync_log WHERE workspace_id = ?", workspaceId);
  return r?.m ?? 0;
}

export async function readChanges(db: D1Database, workspaceId: string, userId: string, after: number, limit = 2000) {
  const rows = await all<{
    id: number;
    entity: EntityName;
    entity_id: string;
    op: "upsert" | "delete";
    data: string | null;
  }>(
    db,
    `SELECT id, entity, entity_id, op, data FROM sync_log
     WHERE workspace_id = ? AND id > ? AND (user_id IS NULL OR user_id = ?)
     ORDER BY id ASC LIMIT ?`,
    workspaceId,
    after,
    userId,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    entityId: r.entity_id,
    op: r.op,
    data: r.data ? JSON.parse(r.data) : null,
  }));
}

export async function notifyRealtime(env: Env, workspaceId: string, lastSyncId: number) {
  if (!env.REALTIME) return;
  try {
    const stub = env.REALTIME.get(env.REALTIME.idFromName(workspaceId));
    await stub.fetch("https://realtime/notify", {
      method: "POST",
      body: JSON.stringify({ lastSyncId }),
    });
  } catch (e) {
    console.error("realtime notify failed", e);
  }
}
