import initSql from "../migrations/0001_init.sql?raw";
import syncMetaSql from "../migrations/0002_sync_meta.sql?raw";
import relationsSql from "../migrations/0003_issue_relations.sql?raw";
import googleAuthSql from "../migrations/0004_google_auth.sql?raw";

type Param = string | number | null;

export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}

export async function first<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/** D1 の batch は最大件数に制限があるため、分割して流す */
export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  const size = 80;
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}

// ---- 自動マイグレーション ----
// wrangler の `d1 migrations apply` と同じ d1_migrations テーブルを使うので、
// どちらの方法で適用しても二重に実行されない。
const MIGRATIONS: { name: string; sql: string }[] = [
  { name: "0001_init.sql", sql: initSql },
  { name: "0002_sync_meta.sql", sql: syncMetaSql },
  { name: "0003_issue_relations.sql", sql: relationsSql },
  { name: "0004_google_auth.sql", sql: googleAuthSql },
];

export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let migrated: Promise<void> | null = null;

export function ensureMigrated(db: D1Database): Promise<void> {
  if (!migrated) {
    migrated = migrate(db).catch((e) => {
      migrated = null;
      throw e;
    });
  }
  return migrated;
}

async function migrate(db: D1Database) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    )
    .run();
  const applied = new Set((await all<{ name: string }>(db, "SELECT name FROM d1_migrations")).map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const statements = splitSql(m.sql).map((s) => db.prepare(s));
    statements.push(db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(m.name));
    await db.batch(statements);
  }
}
