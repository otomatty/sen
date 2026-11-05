// 既存の説明・コメントを HTML から Markdown へ一度だけ移す。
// テストから直接呼ぶため、このファイルは ./markdown 以外の Sen のモジュールを import しない。
// db.prepare / bind / first / all / run と db.batch だけを使う。

import { htmlToMarkdown } from "./markdown";

const PENDING_LIMIT = 50;
const SNAPSHOT = "0009_markdown_bodies:snapshot";
const DONE = "0009_markdown_bodies";

type PendingRow = { table_name: string; row_id: string };
type FoundRow = { id: string; value: string | null };

function readSql(table: string, count: number): string {
  const marks = Array.from({ length: count }, () => "?").join(", ");
  switch (table) {
    case "issues":
      return `SELECT id, description AS value FROM issues WHERE id IN (${marks})`;
    case "projects":
      return `SELECT id, description AS value FROM projects WHERE id IN (${marks})`;
    case "comments":
      return `SELECT id, body AS value FROM comments WHERE id IN (${marks})`;
    default:
      throw new Error(`markdown_pending に未知の表があります: ${table}`);
  }
}

function updateSql(table: string): string {
  switch (table) {
    case "issues":
      return "UPDATE issues SET description = ? WHERE id = ? AND EXISTS (SELECT 1 FROM markdown_pending WHERE table_name = ? AND row_id = ?)";
    case "projects":
      return "UPDATE projects SET description = ? WHERE id = ? AND EXISTS (SELECT 1 FROM markdown_pending WHERE table_name = ? AND row_id = ?)";
    case "comments":
      return "UPDATE comments SET body = ? WHERE id = ? AND EXISTS (SELECT 1 FROM markdown_pending WHERE table_name = ? AND row_id = ?)";
    default:
      throw new Error(`markdown_pending に未知の表があります: ${table}`);
  }
}

async function snapshot(db: D1Database): Promise<void> {
  try {
    // 一覧の作成と目印の挿入を 1 つのトランザクションにする。INSERT に OR IGNORE は付けない。
    // すでに目印があれば一意制約で失敗し、batch 全体が取り消される。
    await db.batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS markdown_pending (table_name TEXT NOT NULL, row_id TEXT NOT NULL, PRIMARY KEY (table_name, row_id))",
      ),
      db.prepare("INSERT INTO d1_migrations (name) VALUES ('0009_markdown_bodies:snapshot')"),
      db.prepare("INSERT INTO markdown_pending (table_name, row_id) SELECT 'issues', id FROM issues WHERE description <> ''"),
      db.prepare("INSERT INTO markdown_pending (table_name, row_id) SELECT 'projects', id FROM projects WHERE description <> ''"),
      db.prepare("INSERT INTO markdown_pending (table_name, row_id) SELECT 'comments', id FROM comments WHERE body <> ''"),
    ]);
  } catch (e) {
    const row = await db.prepare("SELECT name FROM d1_migrations WHERE name = ?").bind(SNAPSHOT).first<{ name: string }>();
    if (row) return;
    throw e;
  }
}

async function convertPending(db: D1Database): Promise<void> {
  for (;;) {
    const listed = await db
      .prepare("SELECT table_name, row_id FROM markdown_pending ORDER BY table_name, row_id LIMIT ?")
      .bind(PENDING_LIMIT)
      .all<PendingRow>();
    const rows = listed.results ?? [];
    if (!rows.length) return;
    // 1 行ずつ first() すると、batch の前に D1 のクエリ上限（Free は 50）を超える。
    // 表ごとに IN で読むので、1 ページは一覧・表の読み取り・batch で最大 5 回。
    const idsByTable = new Map<string, string[]>();
    for (const row of rows) {
      const ids = idsByTable.get(row.table_name);
      if (ids) ids.push(row.row_id);
      else idsByTable.set(row.table_name, [row.row_id]);
    }
    const foundByTable = new Map<string, Map<string, string | null>>();
    for (const [table, ids] of idsByTable) {
      const found = await db.prepare(readSql(table, ids.length)).bind(...ids).all<FoundRow>();
      const byId = new Map<string, string | null>();
      for (const item of found.results ?? []) byId.set(item.id, item.value);
      foundByTable.set(table, byId);
    }
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      const table = row.table_name;
      const id = row.row_id;
      const byId = foundByTable.get(table);
      if (!byId?.has(id)) {
        statements.push(db.prepare("DELETE FROM markdown_pending WHERE table_name = ? AND row_id = ?").bind(table, id));
        continue;
      }
      // updated_at は変えない。人の編集ではないので、並び順やスプレッドシートの日付に影響させない。
      const markdown = htmlToMarkdown(byId.get(id) ?? "");
      statements.push(
        db.prepare(updateSql(table)).bind(markdown, id, table, id),
        db.prepare("DELETE FROM markdown_pending WHERE table_name = ? AND row_id = ?").bind(table, id),
      );
    }
    // 既存の batch() ヘルパーは 80 文で分割してしまう。50 行分は 1 つのトランザクションで流す。
    await db.batch(statements);
  }
}

async function finish(db: D1Database, writeMarker: (workspaceId: string) => Promise<number>): Promise<void> {
  const listed = await db.prepare("SELECT id FROM workspaces").all<{ id: string }>();
  for (const ws of listed.results ?? []) {
    const id = await writeMarker(ws.id);
    // 同期ログには変換前の HTML を含むスナップショットが残っている。
    // pruned_before より前の番号を持つクライアントには、全体の読み込み直しを指示する（worker/app.ts の /sync）。
    // 目印の行を 1 行足してからその番号にするので、移行の直後に読み込んだクライアントの最新番号（getLastSyncId）が
    // pruned_before を下回らず、読み込み直しが繰り返されない。同期ログの行は消さない（毎日の掃除に任せる）。
    await db
      .prepare(
        `INSERT INTO sync_meta (workspace_id, pruned_before) VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET pruned_before = MAX(sync_meta.pruned_before, excluded.pruned_before)`,
      )
      .bind(ws.id, id)
      .run();
  }
  await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(DONE).run();
  // markdown_pending は空のまま残す。消すと、同時に走っている Worker の SELECT が失敗する。
}

export async function migrateBodiesToMarkdown(
  db: D1Database,
  writeMarker: (workspaceId: string) => Promise<number>,
): Promise<void> {
  const done = await db.prepare("SELECT name FROM d1_migrations WHERE name = ?").bind(DONE).first<{ name: string }>();
  if (done) return;
  await snapshot(db);
  await convertPending(db);
  await finish(db, writeMarker);
}
