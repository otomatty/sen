// ---------------------------------------------------------------------------
// ブラウザ内デモ
//
// 本番と同じ Hono のバックエンド（worker/app.ts）を、そのままブラウザの中で動かす。
// D1 の代わりに SQLite（sql.js / asm.js 版）を使い、データは IndexedDB に保存する。
// サーバーが無くても、単一の HTML ファイルだけでアプリ全体を試せる。
// ---------------------------------------------------------------------------
// @ts-expect-error 型定義のない CommonJS モジュール
import initSqlJs from "sql.js/dist/sql-asm.js";
import { createApp } from "../worker/app";
import type { Env } from "../worker/env";
import { setBearerToken, setTransport } from "../src/lib/api";
import { engine } from "../src/store/engine";
import { readLocal, writeLocal } from "../src/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */
type SqlDb = any;

const DB_KEY = "sen-demo-db-v1";
const TOKEN_KEY = "sen:demo-token";

// ---- IndexedDB への保存（失敗してもメモリ上で動き続ける） ----
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("sen-demo", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function loadBytes(): Promise<Uint8Array | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction("kv").objectStore("kv").get(DB_KEY);
      req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(sql: SqlDb) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const db = await idb();
    if (!db) return;
    try {
      db.transaction("kv", "readwrite").objectStore("kv").put(sql.export(), DB_KEY);
    } catch {
      // 保存できなくても続行
    }
  }, 400);
}

// ---- D1 互換の薄いラッパー ----
class Stmt {
  constructor(
    private shim: D1Shim,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.shim, this.sql, params);
  }
  private exec(): { rows: Record<string, unknown>[]; changes: number; lastId: number } {
    const db = this.shim.sqlite;
    const st = db.prepare(this.sql);
    try {
      st.bind(this.params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p)));
      const rows: Record<string, unknown>[] = [];
      while (st.step()) rows.push(st.getAsObject());
      const changes = db.getRowsModified();
      const lastId = Number(db.exec("SELECT last_insert_rowid() AS id")[0]?.values[0][0] ?? 0);
      if (!/^\s*(select|with)/i.test(this.sql)) this.shim.dirty();
      return { rows, changes, lastId };
    } finally {
      st.free();
    }
  }
  async all<T>() {
    const r = this.exec();
    return { results: r.rows as T[], success: true, meta: { changes: r.changes, last_row_id: r.lastId } };
  }
  async first<T>(col?: string) {
    const r = this.exec();
    const row = r.rows[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async run() {
    const r = this.exec();
    return { results: [], success: true, meta: { changes: r.changes, last_row_id: r.lastId } };
  }
  async raw() {
    return this.exec().rows.map((r) => Object.values(r));
  }
  /** batch 用（同期実行） */
  runSync() {
    return this.exec();
  }
}

class D1Shim {
  // Better Auth は `db` というプロパティを持つオブジェクトを Kysely の設定とみなすので、別の名前にする
  constructor(readonly sqlite: SqlDb) {}
  dirty() {
    scheduleSave(this.sqlite);
  }
  prepare(sql: string) {
    return new Stmt(this, sql);
  }
  async batch(stmts: Stmt[]) {
    this.sqlite.run("BEGIN");
    try {
      const out = stmts.map((s) => {
        const r = s.runSync();
        return { results: r.rows, success: true, meta: { changes: r.changes, last_row_id: r.lastId } };
      });
      this.sqlite.run("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.run("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    this.dirty();
    return { count: 1, duration: 0 };
  }
}

const DEMO_USER = { name: "山田 太郎", email: "taro@example.com", workspaceName: "ミライ株式会社" };

export async function startDemoBackend() {
  const SQL = await initSqlJs();
  const bytes = await loadBytes();
  const sql = bytes ? new SQL.Database(bytes) : new SQL.Database();
  const d1 = new D1Shim(sql);
  const env = { DB: d1 as unknown as D1Database, DEV_TOOLS: "1", DEMO_MODE: "1" } as Env;
  const app = createApp();
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

  setTransport(async (input, init) => {
    const res = await app.fetch(new Request(new URL(input, location.href), init), env, ctx);
    return res;
  });
  // ブラウザ内デモにはリアルタイム同期のサーバーがない
  engine.realtimeEnabled = false;
  engine.cacheEnabled = false;

  const call = async <T>(path: string, body?: unknown, token?: string | null): Promise<T> => {
    const res = await app.fetch(
      new Request(new URL(path, location.href), {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-sen-client": "1", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    return (await res.json()) as T;
  };

  let token = readLocal<string | null>(TOKEN_KEY, null);
  const loggedOut = readLocal<boolean>("sen:demo-logged-out", false);
  if (!bytes || (!token && !loggedOut)) {
    // 初回：デモ用アカウントでログインし、サンプルデータ入りのワークスペースを用意する
    token = (await call<{ token?: string }>("/api/auth/dev/sign-in", { email: DEMO_USER.email, name: DEMO_USER.name })).token ?? null;
    if (token) {
      const me = await call<{ workspaces: { urlKey: string }[] }>("/api/me", undefined, token);
      let key = me.workspaces[0]?.urlKey;
      if (!key) {
        key = (await call<{ workspaceKey: string }>("/api/workspaces", { name: DEMO_USER.workspaceName }, token)).workspaceKey;
        await call(`/api/dev/seed-demo?ws=${key}`, {}, token);
      }
      writeLocal("sen:last-ws", key);
    }
    writeLocal(TOKEN_KEY, token);
  }
  setBearerToken(token);
}

/** デモのデータを初期状態に戻す */
export async function resetDemo() {
  const db = await idb();
  if (db) db.transaction("kv", "readwrite").objectStore("kv").delete(DB_KEY);
  writeLocal(TOKEN_KEY, null);
  location.reload();
}
