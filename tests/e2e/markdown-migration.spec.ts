import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { markdownToText } from "../../shared/markdown";
import { htmlToMarkdown } from "../../worker/markdown";
import { migrateBodiesToMarkdown } from "../../worker/markdown-migration";

// このテストは Node から移行処理を直接呼ぶ。Worker の型はここだけ足し、本体の D1Database と同じ名前で扱う。
declare global {
  interface D1Result<T = unknown> {
    results?: T[];
  }
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(colName?: string): Promise<T | null>;
    all<T = unknown>(): Promise<D1Result<T>>;
    run<T = unknown>(): Promise<D1Result<T>>;
  }
  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  }
}

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js/dist/sql-asm.js") as () => Promise<{
  Database: new () => SqlDb;
}>;

type SqlStatement = {
  bind(params: unknown[]): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
};

type SqlDb = {
  prepare(sql: string): SqlStatement;
  run(sql: string): void;
  getRowsModified(): number;
};

/** worker/db.ts の splitSql と同じ分け方 */
function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

class Stmt {
  constructor(
    private shim: MiniD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Stmt(this.shim, this.sql, params);
  }

  runSync(): { results: Record<string, unknown>[] } {
    const st = this.shim.sqlite.prepare(this.sql);
    try {
      if (this.params.length) st.bind(this.params.map((p) => (p === undefined ? null : p)));
      const results: Record<string, unknown>[] = [];
      while (st.step()) results.push(st.getAsObject());
      return { results };
    } finally {
      st.free();
    }
  }

  async all<T>() {
    this.shim.charge();
    this.shim.queries.push(this.sql);
    return { results: this.runSync().results as T[] };
  }

  async first<T>() {
    this.shim.charge();
    this.shim.queries.push(this.sql);
    return (this.runSync().results[0] as T | undefined) ?? null;
  }

  async run() {
    this.shim.charge();
    this.shim.queries.push(this.sql);
    this.runSync();
    return { success: true as const };
  }
}

/** D1 が 1 回の Worker 呼び出しで流せるクエリ数を超えたときのメッセージ */
const D1_QUERY_LIMIT_ERROR = "D1_ERROR: Too many API requests by single Worker invocation.";

class MiniD1 {
  batchCount = 0;
  queries: string[] = [];
  /** 設定すると、この回数を超えたクエリで D1 と同じく失敗する。batch は 1 回と数える。 */
  queryLimit: number | undefined;
  queryCount = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly sqlite: SqlDb,
    private beforeBatch?: (n: number) => void,
  ) {}

  /** クエリを 1 回消費する。上限を超えたら SQL は流さない。 */
  charge() {
    if (this.queryLimit === undefined) return;
    this.queryCount += 1;
    if (this.queryCount > this.queryLimit) throw new Error(D1_QUERY_LIMIT_ERROR);
  }

  prepare(sql: string) {
    return new Stmt(this, sql);
  }

  batch(statements: Stmt[]) {
    const run = this.queue.then(() => {
      this.charge();
      this.queries.push("batch");
      this.batchCount += 1;
      this.beforeBatch?.(this.batchCount);
      this.sqlite.run("BEGIN");
      try {
        const out = statements.map((statement) => statement.runSync());
        this.sqlite.run("COMMIT");
        return out;
      } catch (e) {
        try {
          this.sqlite.run("ROLLBACK");
        } catch {
          // 失敗時点でトランザクションが閉じていることがある
        }
        throw e;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

const MIGRATION_FILES = [
  "0001_init.sql",
  "0002_sync_meta.sql",
  "0003_issue_relations.sql",
  "0004_google_auth.sql",
  "0005_ai_tokens.sql",
  "0006_default_workspace.sql",
  "0007_invitations.sql",
  "0008_assistant_usage.sql",
];

async function openDb(beforeBatch?: (n: number) => void) {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run(
    "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const dir = path.join(process.cwd(), "migrations");
  for (const name of MIGRATION_FILES) {
    for (const statement of splitSql(fs.readFileSync(path.join(dir, name), "utf8"))) sqlite.run(statement);
  }
  return new MiniD1(sqlite, beforeBatch);
}

async function insertWorkspace(db: MiniD1, id: string) {
  await db
    .prepare("INSERT INTO workspaces (id, name, url_key, invite_code, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .bind(id, id, id, `invite-${id}`)
    .run();
}

async function insertIssue(db: MiniD1, row: { id: string; ws: string; description: string; updatedAt: number; number: number }) {
  await db
    .prepare(
      `INSERT INTO issues (id, workspace_id, team_id, number, title, description, state_id, creator_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, '題', ?, 'state', 'user', 1, ?)`,
    )
    .bind(row.id, row.ws, `team-${row.ws}`, row.number, row.description, row.updatedAt)
    .run();
}

async function insertProject(db: MiniD1, row: { id: string; ws: string; description: string; updatedAt: number }) {
  await db
    .prepare(
      "INSERT INTO projects (id, workspace_id, name, description, color, created_at, updated_at) VALUES (?, ?, '計画', ?, '#6470e8', 1, ?)",
    )
    .bind(row.id, row.ws, row.description, row.updatedAt)
    .run();
}

async function insertComment(db: MiniD1, row: { id: string; ws: string; body: string; updatedAt: number }) {
  await db
    .prepare(
      "INSERT INTO comments (id, workspace_id, issue_id, user_id, body, created_at, updated_at) VALUES (?, ?, 'issue', 'user', ?, 1, ?)",
    )
    .bind(row.id, row.ws, row.body, row.updatedAt)
    .run();
}

function markerFor(db: MiniD1) {
  const returned = new Map<string, number>();
  return {
    returned,
    async write(workspaceId: string) {
      await db
        .prepare(
          "INSERT INTO sync_log (workspace_id, entity, entity_id, op, data, user_id, created_at) VALUES (?, 'workspace', ?, 'upsert', '{}', NULL, 1)",
        )
        .bind(workspaceId, workspaceId)
        .run();
      const row = await db.prepare("SELECT MAX(id) AS m FROM sync_log WHERE workspace_id = ?").bind(workspaceId).first<{ m: number }>();
      const id = Number(row?.m ?? 0);
      returned.set(workspaceId, id);
      return id;
    },
  };
}

async function value(db: MiniD1, sql: string, id: string) {
  const row = await db.prepare(sql).bind(id).first<{ value: string; updated_at: number }>();
  return row;
}

async function names(db: MiniD1) {
  const rows = await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
  return (rows.results ?? []).map((row) => row.name);
}

async function pendingCount(db: MiniD1) {
  const row = await db.prepare("SELECT COUNT(*) AS c FROM markdown_pending").first<{ c: number }>();
  return Number(row?.c ?? 0);
}

const RICH =
  '<h2>見出し</h2><p>これは <strong>太字</strong> と <code>code</code> です</p><ul><li><p>項目</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>済み</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>未</p></div></li></ul><p><a href="https://example.com">Sen</a></p>';

const SENTINEL = "<p><strong>a</strong> と a_b</p>";

test("HTML の本文を Markdown にし、2 回目は何も変えない", async () => {
  const db = await openDb();
  await insertWorkspace(db, "ws-a");
  await insertWorkspace(db, "ws-b");
  await insertIssue(db, { id: "issue-rich", ws: "ws-a", description: RICH, updatedAt: 111, number: 1 });
  await insertIssue(db, { id: "issue-empty", ws: "ws-a", description: "", updatedAt: 222, number: 2 });
  await insertProject(db, { id: "project-1", ws: "ws-a", description: "<p>計画 <strong>太字</strong></p>", updatedAt: 333 });
  await insertComment(db, { id: "comment-1", ws: "ws-a", body: "<p>了解 <code>ok</code></p><ul><li><p>次</p></li></ul>", updatedAt: 444 });
  await insertIssue(db, { id: "issue-b", ws: "ws-b", description: "<p>別の説明</p>", updatedAt: 555, number: 1 });

  const marker = markerFor(db);
  await migrateBodiesToMarkdown(db as never, marker.write);

  const rich = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "issue-rich");
  expect(rich?.value).toBe(htmlToMarkdown(RICH));
  expect(rich?.value).toContain("## 見出し");
  expect(rich?.value).toContain("**太字**");
  expect(rich?.value).toContain("`code`");
  expect(rich?.value).toContain("- 項目");
  expect(rich?.value).toContain("- [x] 済み");
  expect(rich?.value).toContain("- [ ] 未");
  expect(rich?.value).toContain("[Sen](https://example.com)");
  expect(rich?.value).not.toContain("<p>");
  expect(rich?.value).not.toContain("<strong>");
  expect(rich?.updated_at).toBe(111);

  const empty = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "issue-empty");
  expect(empty?.value).toBe("");
  expect(empty?.updated_at).toBe(222);

  const project = await value(db, "SELECT description AS value, updated_at FROM projects WHERE id = ?", "project-1");
  expect(project?.value).toBe(htmlToMarkdown("<p>計画 <strong>太字</strong></p>"));
  expect(project?.value).toContain("**太字**");
  expect(project?.updated_at).toBe(333);

  const comment = await value(db, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "comment-1");
  expect(comment?.value).toBe(htmlToMarkdown("<p>了解 <code>ok</code></p><ul><li><p>次</p></li></ul>"));
  expect(comment?.value).toContain("`ok`");
  expect(comment?.value).toContain("- 次");
  expect(comment?.updated_at).toBe(444);

  const other = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "issue-b");
  expect(other?.value).toBe("別の説明");
  expect(other?.updated_at).toBe(555);

  const recorded = await names(db);
  expect(recorded).toContain("0009_markdown_bodies");
  expect(recorded).toContain("0009_markdown_bodies:snapshot");
  expect(await pendingCount(db)).toBe(0);

  for (const wsId of ["ws-a", "ws-b"]) {
    const meta = await db.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind(wsId).first<{ pruned_before: number }>();
    expect(meta?.pruned_before).toBe(marker.returned.get(wsId));
  }

  const snapshot = {
    rich: rich?.value,
    empty: empty?.value,
    project: project?.value,
    comment: comment?.value,
    other: other?.value,
    pending: await pendingCount(db),
    prunedA: (await db.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind("ws-a").first<{ pruned_before: number }>())?.pruned_before,
    prunedB: (await db.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind("ws-b").first<{ pruned_before: number }>())?.pruned_before,
  };
  await migrateBodiesToMarkdown(db as never, marker.write);
  const richAgain = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "issue-rich");
  const projectAgain = await value(db, "SELECT description AS value, updated_at FROM projects WHERE id = ?", "project-1");
  const commentAgain = await value(db, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "comment-1");
  expect(richAgain).toEqual(rich);
  expect(projectAgain?.value).toBe(snapshot.project);
  expect(commentAgain?.value).toBe(snapshot.comment);
  expect(await pendingCount(db)).toBe(snapshot.pending);
  expect((await db.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind("ws-a").first<{ pruned_before: number }>())?.pruned_before).toBe(snapshot.prunedA);
  expect((await db.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind("ws-b").first<{ pruned_before: number }>())?.pruned_before).toBe(snapshot.prunedB);
  expect(snapshot.empty).toBe("");
});

test("同時に走らせても、途中で失敗しても、本文は 1 回しか変換しない", async () => {
  const once = htmlToMarkdown(SENTINEL);
  const twice = htmlToMarkdown(once);
  expect(twice).not.toBe(once);

  const db = await openDb();
  await insertWorkspace(db, "ws");
  await insertIssue(db, { id: "once", ws: "ws", description: SENTINEL, updatedAt: 10, number: 1 });
  await insertComment(db, { id: "once-comment", ws: "ws", body: SENTINEL, updatedAt: 11 });
  const marker = markerFor(db);
  await Promise.all([migrateBodiesToMarkdown(db as never, marker.write), migrateBodiesToMarkdown(db as never, marker.write)]);
  const issue = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "once");
  const comment = await value(db, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "once-comment");
  expect(issue?.value).toBe(once);
  expect(comment?.value).toBe(once);
  expect(issue?.updated_at).toBe(10);
  expect(comment?.updated_at).toBe(11);
  expect(await pendingCount(db)).toBe(0);

  let failAt = 3;
  const retry = await openDb((n) => {
    if (n === failAt) throw new Error("変換の途中で失敗");
  });
  await insertWorkspace(retry, "ws");
  for (let i = 0; i <= 50; i++) {
    const id = `c${String(i).padStart(2, "0")}`;
    const body = i === 0 || i === 50 ? SENTINEL : `<p>項目 ${i}</p>`;
    await insertComment(retry, { id, ws: "ws", body, updatedAt: 1000 + i });
  }
  const retryMarker = markerFor(retry);
  await expect(migrateBodiesToMarkdown(retry as never, retryMarker.write)).rejects.toThrow("変換の途中で失敗");
  const converted = await value(retry, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "c00");
  const waiting = await value(retry, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "c50");
  expect(converted?.value).toBe(once);
  expect(converted?.updated_at).toBe(1000);
  expect(waiting?.value).toBe(SENTINEL);
  expect(waiting?.updated_at).toBe(1050);
  expect(await names(retry)).toContain("0009_markdown_bodies:snapshot");
  expect(await names(retry)).not.toContain("0009_markdown_bodies");
  expect(await pendingCount(retry)).toBe(1);

  failAt = 0;
  await migrateBodiesToMarkdown(retry as never, retryMarker.write);
  const convertedAgain = await value(retry, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "c00");
  const finished = await value(retry, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "c50");
  expect(convertedAgain?.value).toBe(once);
  expect(finished?.value).toBe(once);
  expect(finished?.updated_at).toBe(1050);
  const plain = await value(retry, "SELECT body AS value FROM comments WHERE id = ?", "c01");
  expect(plain?.value).toBe(htmlToMarkdown("<p>項目 1</p>"));
  expect(await pendingCount(retry)).toBe(0);
  expect(await names(retry)).toContain("0009_markdown_bodies");
  expect((await retry.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind("ws").first<{ pruned_before: number }>())?.pruned_before).toBe(
    retryMarker.returned.get("ws"),
  );
});

/** 一覧の取得、表ごとの読み取り、batch。1 ページ分の回数 */
function pageQueryCounts(queries: string[]): number[] {
  const counts: number[] = [];
  let current: number | null = null;
  const isList = (sql: string) => sql.includes("FROM markdown_pending ORDER BY");
  const isRead = (sql: string) => /^SELECT id, \w+ AS value FROM (?:issues|projects|comments) WHERE id IN \(/.test(sql);
  for (const sql of queries) {
    if (isList(sql)) {
      if (current !== null) counts.push(current);
      current = 1;
      continue;
    }
    if (current === null) continue;
    if (sql === "batch" || isRead(sql)) current += 1;
  }
  if (current !== null) counts.push(current);
  return counts;
}

test("100 行の移行は、1 ページあたり一覧・表の読み取り・batch が 5 回以下", async () => {
  const db = await openDb();
  await insertWorkspace(db, "ws");
  for (let i = 0; i < 10; i++) {
    const id = `c${String(i).padStart(2, "0")}`;
    await insertComment(db, { id, ws: "ws", body: `<p>コメント ${i}</p>`, updatedAt: 1000 + i });
  }
  for (let i = 0; i < 10; i++) {
    const id = `i${String(i).padStart(2, "0")}`;
    await insertIssue(db, { id, ws: "ws", description: `<p>課題 ${i}</p>`, updatedAt: 2000 + i, number: i + 1 });
  }
  for (let i = 0; i < 80; i++) {
    const id = `p${String(i).padStart(2, "0")}`;
    await insertProject(db, { id, ws: "ws", description: `<p>計画 ${i}</p>`, updatedAt: 3000 + i });
  }
  const marker = markerFor(db);
  db.queries.length = 0;
  await migrateBodiesToMarkdown(db as never, marker.write);
  const counts = pageQueryCounts(db.queries);
  expect(counts.length).toBeGreaterThan(0);
  for (const count of counts) expect(count).toBeLessThanOrEqual(5);
  expect(await pendingCount(db)).toBe(0);
  const comment = await value(db, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "c00");
  const issue = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "i00");
  const project = await value(db, "SELECT description AS value, updated_at FROM projects WHERE id = ?", "p79");
  expect(comment?.value).toBe(htmlToMarkdown("<p>コメント 0</p>"));
  expect(comment?.updated_at).toBe(1000);
  expect(issue?.value).toBe(htmlToMarkdown("<p>課題 0</p>"));
  expect(issue?.updated_at).toBe(2000);
  expect(project?.value).toBe(htmlToMarkdown("<p>計画 79</p>"));
  expect(project?.updated_at).toBe(3079);
});

test("クエリ上限で仕上げが途中で切れても、続きから終わる", async () => {
  const once = htmlToMarkdown(SENTINEL);
  expect(htmlToMarkdown(once)).not.toBe(once);

  const db = await openDb();
  const workspaceIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const id = `ws-${String(i).padStart(2, "0")}`;
    workspaceIds.push(id);
    await insertWorkspace(db, id);
  }
  await insertIssue(db, { id: "limit-issue", ws: "ws-00", description: SENTINEL, updatedAt: 11, number: 1 });
  await insertProject(db, { id: "limit-project", ws: "ws-01", description: SENTINEL, updatedAt: 22 });
  await insertComment(db, { id: "limit-comment", ws: "ws-02", body: SENTINEL, updatedAt: 33 });

  db.queryLimit = 50;
  const marker = markerFor(db);
  let finished = false;
  let attempts = 0;
  for (; attempts < 10; attempts++) {
    db.queryCount = 0;
    try {
      await migrateBodiesToMarkdown(db as never, marker.write);
      finished = true;
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).toContain(D1_QUERY_LIMIT_ERROR);
    }
  }
  expect(finished).toBe(true);
  expect(attempts).toBeGreaterThan(0);
  expect(attempts).toBeLessThan(10);

  db.queryLimit = undefined;
  const issue = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "limit-issue");
  const project = await value(db, "SELECT description AS value, updated_at FROM projects WHERE id = ?", "limit-project");
  const comment = await value(db, "SELECT body AS value, updated_at FROM comments WHERE id = ?", "limit-comment");
  expect(issue?.value).toBe(once);
  expect(issue?.updated_at).toBe(11);
  expect(project?.value).toBe(once);
  expect(project?.updated_at).toBe(22);
  expect(comment?.value).toBe(once);
  expect(comment?.updated_at).toBe(33);

  for (const wsId of workspaceIds) {
    const meta = await db.prepare("SELECT pruned_before FROM sync_meta WHERE workspace_id = ?").bind(wsId).first<{ pruned_before: number }>();
    const rows = await db.prepare("SELECT id FROM sync_log WHERE workspace_id = ?").bind(wsId).all<{ id: number }>();
    expect(rows.results?.length).toBeGreaterThan(0);
    for (const row of rows.results ?? []) expect(meta?.pruned_before).toBeGreaterThanOrEqual(row.id);
  }

  const done = await db.prepare("SELECT COUNT(*) AS c FROM d1_migrations WHERE name = ?").bind("0009_markdown_bodies").first<{ c: number }>();
  expect(Number(done?.c ?? 0)).toBe(1);
});

test("壊れる行内は書式を外して保存し、警告には行の ID だけを出す", async () => {
  const html = "<p><strong>a<code>c</code></strong>です</p>";
  const db = await openDb();
  await insertWorkspace(db, "ws");
  await insertIssue(db, { id: "issue-plain", ws: "ws", description: html, updatedAt: 7, number: 1 });
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await migrateBodiesToMarkdown(db as never, markerFor(db).write);
  } finally {
    console.warn = original;
  }
  const saved = await value(db, "SELECT description AS value, updated_at FROM issues WHERE id = ?", "issue-plain");
  expect(saved?.value).not.toContain("*");
  expect(markdownToText(saved?.value ?? "")).toBe("acです");
  expect(saved?.updated_at).toBe(7);
  const warned = warnings.join("\n");
  expect(warned).toContain("issue-plain");
  expect(warned).toContain("issues");
  expect(warned).not.toContain(html);
  expect(warned).not.toContain("acです");
  expect(warned).not.toContain("<code>");
  expect(warned).not.toContain("<strong>");
});
