// Playwright からは bun で起動する。同期の実装は SQL の raw import を含むため、
// Playwright の変換では読めない。ここは待ち時間を使わず、呼び出しの順で確かめる。

import { createRequire } from "node:module";
import type { Server } from "node:http";
import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import { ensureMigrated } from "../../worker/db";
import type { Env, WorkspaceRow } from "../../worker/env";
import { insertTeam } from "../../worker/mutations";
import { scheduleGitHubSync } from "../../worker/github/config";
import { GitHubSyncRunner } from "../../worker/github/runner";
import { syncPull } from "../../worker/github/pull-sync";
import { pullComment, pushComment, reconcileIssue, runManual, scanUpdates, type SyncCtx } from "../../worker/github/sync";
import { GITHUB_TOKEN, githubMock, resetGitHubMock, startGitHubMock } from "./github-mock";

const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js/dist/sql-asm.js") as () => Promise<{ Database: new () => SqlDb }>;

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

class Stmt {
  constructor(
    private shim: MiniD1,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new Stmt(this.shim, this.sql, params);
  }

  private runSync(): { results: Record<string, unknown>[] } {
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
    const results = this.runSync().results as T[];
    await this.fireAfter();
    return { results };
  }

  async first<T>() {
    const row = (this.runSync().results[0] as T | undefined) ?? null;
    await this.fireAfter();
    return row;
  }

  async run() {
    this.runSync();
    const changes = this.shim.sqlite.getRowsModified();
    await this.fireAfter();
    return { success: true as const, meta: { changes } };
  }

  private async fireAfter(): Promise<void> {
    const hook = this.shim.afterSql;
    if (!hook || !this.sql.includes(hook.includes)) return;
    this.shim.afterSql = null;
    await hook.run();
  }
}

class MiniD1 {
  /** この文字列を含む SQL の実行直後に、一度だけ呼ぶ。指定が無ければ何もしない */
  afterSql: { includes: string; run: () => Promise<void> } | null = null;

  constructor(readonly sqlite: SqlDb) {}

  prepare(sql: string) {
    return new Stmt(this, sql);
  }

  async batch(statements: Stmt[]) {
    this.sqlite.run("BEGIN");
    try {
      const out = statements.map((statement) => {
        const st = this.sqlite.prepare(statement.sql);
        try {
          if (statement.params.length) st.bind(statement.params.map((p) => (p === undefined ? null : p)));
          const results: Record<string, unknown>[] = [];
          while (st.step()) results.push(st.getAsObject());
          return { results };
        } finally {
          st.free();
        }
      });
      this.sqlite.run("COMMIT");
      return out;
    } catch (e) {
      try {
        this.sqlite.run("ROLLBACK");
      } catch {
        // すでに閉じていることがある
      }
      throw e;
    }
  }
}

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function openDb(): Promise<D1Database> {
  const SQL = await initSqlJs();
  const db = new MiniD1(new SQL.Database()) as unknown as D1Database;
  await ensureMigrated(db);
  return db;
}

function envFor(db: D1Database): Env {
  return {
    DB: db,
    REALTIME: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("ok") }),
    },
    DEV_TOOLS: "1",
    GITHUB_WORKSPACE: "retry",
    GITHUB_TOKEN,
    GITHUB_WEBHOOK_SECRET: "retry-secret",
    GITHUB_API_ORIGIN_FOR_TESTS: `http://127.0.0.1:${Number(process.env.E2E_GITHUB_PORT ?? 4339)}`,
    GITHUB_SYNC_DELAY_MS: "0",
  } as unknown as Env;
}

async function q<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

async function exec(db: D1Database, sql: string, ...params: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

async function seed(db: D1Database): Promise<{ ws: string; user: string; team: string; state: string; repo: number }> {
  const now = Date.now();
  const ws = "ws-retry";
  const user = "11111111-1111-4111-8111-111111111111";
  const team = "22222222-2222-4222-8222-222222222222";
  await exec(
    db,
    "INSERT INTO workspaces (id, name, url_key, invite_code, created_at, updated_at, allowed_domains) VALUES (?, 'Retry', 'retry', 'invite-retry', ?, ?, '[]')",
    ws,
    now,
    now,
  );
  await exec(
    db,
    "INSERT INTO users (id, email, name, avatar_color, settings, created_at, updated_at, default_workspace_id) VALUES (?, 'retry@example.com', '再試行 太郎', '#6470e8', '{}', ?, ?, ?)",
    user,
    now,
    now,
    ws,
  );
  await exec(db, "INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)", ws, user, now);
  const { stateIds } = await insertTeam(db, ws, { id: team, name: "Retry", key: "RET", color: "#6470e8" }, now);
  const repo = githubMock.repos.get("acme/widgets")!;
  await exec(
    db,
    `INSERT INTO github_repos (team_id, workspace_id, repo_id, full_name, linked_by, linked_at, created_at, updated_at)
     VALUES (?, ?, ?, 'acme/widgets', ?, ?, ?, ?)`,
    team,
    ws,
    repo.id,
    user,
    now - 60_000,
    now,
    now,
  );
  return { ws, user, team, state: stateIds["未着手"] ?? "", repo: repo.id };
}

function ctxFor(db: D1Database, ws: string, queued: string[]): SyncCtx {
  return {
    env: envFor(db),
    workspaceId: ws,
    labelCache: new Map(),
    enqueueComment: async (id) => {
      queued.push(id);
    },
  };
}

async function resetRows(db: D1Database): Promise<void> {
  (db as unknown as MiniD1).afterSql = null;
  for (const table of [
    "github_comment_links",
    "github_issue_links",
    "github_sync_attempts",
    "github_issue_create_skips",
    "github_import_skips",
    "comments",
    "notifications",
    "activities",
    "sync_log",
    "issues",
  ]) {
    await exec(db, `DELETE FROM ${table}`);
  }
  resetGitHubMock();
}

async function insertIssue(
  db: D1Database,
  row: { id: string; ws: string; team: string; state: string; user: string; number: number; title: string; description: string },
): Promise<void> {
  const now = Date.now();
  await exec(
    db,
    `INSERT INTO issues (id, workspace_id, team_id, number, title, description, state_id, creator_id, label_ids, subscriber_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
    row.id,
    row.ws,
    row.team,
    row.number,
    row.title,
    row.description,
    row.state,
    row.user,
    now,
    now,
  );
}

async function insertLink(db: D1Database, ws: string, issueId: string, repo: number, number: number): Promise<void> {
  const now = Date.now();
  await exec(
    db,
    `INSERT INTO github_issue_links (issue_id, workspace_id, repo_id, number, url, base_title, base_body, base_state, base_labels, synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, 't', 'b', 'open', '[]', ?, ?)`,
    issueId,
    ws,
    repo,
    number,
    `https://github.com/acme/widgets/issues/${number}`,
    now,
    now,
  );
}

async function insertComment(
  db: D1Database,
  row: { id: string; ws: string; issue: string; user: string; body: string; edited?: boolean },
): Promise<void> {
  const now = Date.now();
  await exec(
    db,
    "INSERT INTO comments (id, workspace_id, issue_id, user_id, body, created_at, updated_at, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    row.id,
    row.ws,
    row.issue,
    row.user,
    row.body,
    now,
    now,
    row.edited ? now : null,
  );
}

function pushRemote(title: string, body: string): number {
  const fullName = "acme/widgets";
  const number = githubMock.issues.filter((issue) => issue.fullName === fullName).reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
  const now = new Date().toISOString();
  githubMock.issues.push({
    id: githubMock.nextIssueId++,
    number,
    fullName,
    title,
    body,
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    created_at: now,
    updated_at: now,
    user: { login: "someone" },
  });
  return number;
}

function posts(suffix: string): number {
  return githubMock.requests.filter((item) => item.method === "POST" && item.path.endsWith(suffix)).length;
}

async function main(): Promise<void> {
  resetGitHubMock();
  const server: Server = await startGitHubMock();
  try {
    const db = await openDb();
    const seeded = await seed(db);
    check(seeded.state, "未着手がありません");
    await scenarioComment(db, seeded);
    await scenarioIssue(db, seeded);
    await scenarioWebhookBeforeRetry(db, seeded);
    await scenarioImport(db, seeded);
    await scenarioWaitingComment(db, seeded);
    await scenarioManualUnlink(db, seeded);
    await scenarioDeletedUnlink(db, seeded);
    await scenarioEdit(db, seeded);
    await scenarioLong(db, seeded);
    await scenarioMissedComments(db, seeded);
    await scenarioImportCommentRetry(db, seeded);
    await scenarioDecoyIssue(db, seeded);
    await scenarioImportSkip(db, seeded);
    await scenarioSentBase(db, seeded);
    await scenarioBodyConflictKept(db, seeded);
    await scenarioPullAdvance(db, seeded);
    await scenarioScheduleError(db, seeded);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function scenarioComment(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "33333333-3333-4333-8333-333333333333";
  const comment = "44444444-4444-4444-8444-444444444444";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 1, title: "課題", description: "本文" });
  await insertLink(db, seeded.ws, issue, githubMock.repos.get("acme/widgets")!.id, 7);
  await insertComment(db, { id: comment, ws: seeded.ws, issue, user: seeded.user, body: "一度だけ" });
  const ctx = ctxFor(db, seeded.ws, []);
  githubMock.loseOnce = { method: "POST", suffix: "/comments" };
  let lost = false;
  try {
    await pushComment(ctx, comment);
  } catch {
    lost = true;
  }
  check(lost, "A1: 応答の喪失で失敗していない");
  check(githubMock.comments.length === 1, "A1: 投稿が 1 件ではない");
  check(!(await q(db, "SELECT comment_id FROM github_comment_links WHERE comment_id = ?", comment)), "A1: 失ったのに紐づいている");
  await pushComment(ctx, comment);
  check(githubMock.comments.length === 1, "A1: やり直しでコメントが増えた");
  check(posts("/comments") === 1, "A1: POST が 1 回ではない");
  const link = await q<{ github_comment_id: number }>(db, "SELECT github_comment_id FROM github_comment_links WHERE comment_id = ?", comment);
  check(link?.github_comment_id === githubMock.comments[0]?.id, "A1: 紐づけがない");
}

async function scenarioIssue(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "55555555-5555-4555-8555-555555555555";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 2, title: "一度だけの Issue", description: "同じ本文" });
  const ctx = ctxFor(db, seeded.ws, []);
  githubMock.loseOnce = { method: "POST", suffix: "/issues" };
  let lost = false;
  try {
    await reconcileIssue(ctx, { issueId: issue });
  } catch {
    lost = true;
  }
  check(lost, "A2: 応答の喪失で失敗していない");
  check(githubMock.issues.length === 1, "A2: Issue が 1 件ではない");
  check(!(await q(db, "SELECT issue_id FROM github_issue_links WHERE issue_id = ?", issue)), "A2: 失ったのに紐づいている");
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 1, "A2: やり直しで Issue が増えた");
  check(posts("/issues") === 1, "A2: POST が 1 回ではない");
  const link = await q<{ number: number }>(db, "SELECT number FROM github_issue_links WHERE issue_id = ?", issue);
  check(link?.number === githubMock.issues[0]?.number, "A2: 課題と紐づいていない");
  check(!(await q(db, "SELECT target_id FROM github_sync_attempts WHERE kind = 'issue' AND target_id = ?", issue)), "A2: 試行の記録が残っている");
}

async function scenarioImport(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const number = pushRemote("取り込まれる Issue", "GitHub の本文");
  const repo = githubMock.repos.get("acme/widgets")!;
  let armed = true;
  const wrapped = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...params: unknown[]) {
          const bound = statement.bind(...params);
          return new Proxy(bound, {
            get(target, prop, receiver) {
              if (prop === "run") {
                return async () => {
                  if (armed && sql.includes("INSERT INTO github_issue_links")) {
                    armed = false;
                    throw new Error("link insert failed once");
                  }
                  return target.run();
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  } as unknown as D1Database;
  const ctx = ctxFor(wrapped, seeded.ws, []);
  let failed = false;
  try {
    await reconcileIssue(ctx, { repoId: repo.id, number });
  } catch (e) {
    failed = e instanceof Error && e.message === "link insert failed once";
  }
  check(failed, "A3: 紐づけの前で一度失敗していない");
  const mid = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues WHERE title = ?", "取り込まれる Issue");
  check(mid?.n === 1, `A3: 失敗の直後の課題が 1 件ではない (${mid?.n})`);
  check(!(await q(db, "SELECT issue_id FROM github_issue_links")), "A3: 失敗なのに紐づいている");
  await reconcileIssue(ctx, { repoId: repo.id, number });
  const after = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues WHERE title = ?", "取り込まれる Issue");
  check(after?.n === 1, "A3: やり直しで課題が増えた");
  const link = await q<{ number: number }>(db, "SELECT number FROM github_issue_links");
  check(link?.number === number, "A3: 紐づいていない");
}

async function scenarioWaitingComment(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "66666666-6666-4666-8666-666666666666";
  const comment = "77777777-7777-4777-8777-777777777777";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 3, title: "コメントを待つ", description: "本文" });
  await insertComment(db, { id: comment, ws: seeded.ws, issue, user: seeded.user, body: "待っていた" });
  const queued: string[] = [];
  const ctx = ctxFor(db, seeded.ws, queued);
  githubMock.failOnce = { method: "POST", suffix: "/issues" };
  let failed = false;
  try {
    await reconcileIssue(ctx, { issueId: issue });
  } catch {
    failed = true;
  }
  check(failed, "A4: Issue の作成が失敗していない");
  check(githubMock.issues.length === 0, "A4: 失敗なのに Issue がある");
  let waiting = false;
  try {
    await pushComment(ctx, comment);
  } catch (e) {
    waiting = e instanceof Error && e.message === "GitHub の Issue ができるまで待ちます";
  }
  check(waiting, "A4: 紐づけが無いコメントがやり直しになっていない");
  check(githubMock.comments.length === 0, "A4: Issue の前にコメントが送られた");
  await reconcileIssue(ctx, { issueId: issue });
  check(queued.includes(comment), "A4: 紐づけのあとコメントが順番待ちに入っていない");
  await pushComment(ctx, comment);
  check(githubMock.comments.length === 1, "A4: コメントが届いていない");
  check(githubMock.comments[0]?.body.includes("待っていた") === true, "A4: 本文が違う");
  check(githubMock.comments[0]?.body.includes(`<!-- sen:comment:${comment} -->`) === true, "A4: 印がない");
}

function memoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => map.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      map.set(key, value);
    },
    delete: async (key: string): Promise<boolean> => map.delete(key),
    list: async <T>(options?: { prefix?: string }): Promise<Map<string, T>> => {
      const out = new Map<string, T>();
      for (const [key, value] of map) {
        if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, value as T);
      }
      return out;
    },
  } as unknown as DurableObjectStorage;
}

async function scenarioManualUnlink(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const comment = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 6, title: "外す", description: "本文" });
  const ctx = ctxFor(db, seeded.ws, []);
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 1, "C1: 最初の Issue ができていない");
  await runManual(ctx, { workspaceId: seeded.ws, userId: seeded.user, issueId: issue, action: "unlink" });
  check(!(await q(db, "SELECT issue_id FROM github_issue_links WHERE issue_id = ?", issue)), "C1: 紐づけが残っている");
  check(await q(db, "SELECT issue_id FROM github_issue_create_skips WHERE issue_id = ?", issue), "C1: 自動作成を止める記録がない");
  await exec(db, "UPDATE issues SET title = ?, updated_at = ? WHERE id = ?", "編集した", Date.now(), issue);
  const created = posts("/issues");
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 1, "C1: 編集で Issue が増えた");
  check(posts("/issues") === created, "C1: 編集で Issue を作った");
  check(githubMock.issues[0]?.title === "外す", "C1: 残っている Issue のタイトルが変わった");

  await insertComment(db, { id: comment, ws: seeded.ws, issue, user: seeded.user, body: "外したあとのコメント" });
  const storage = memoryStorage();
  const sync = new GitHubSyncRunner(storage, ctx.env, async () => {});
  const marked = await sync.handle(
    new Request("https://realtime/github/mark", {
      method: "POST",
      body: JSON.stringify({ workspaceId: seeded.ws, comments: [comment] }),
    }),
  );
  check(marked?.status === 200, "C1: コメントを受け付けていない");
  await sync.alarm();
  check((await storage.get(`gh:dirty:comment:${comment}`)) === undefined, "C1: コメントがやり直しに残った");
  check(githubMock.comments.length === 0, "C1: 外した課題のコメントが送られた");
  await sync.alarm();
  check(githubMock.comments.length === 0, "C1: もう一度鳴らしてもコメントが送られた");

  await runManual(ctx, { workspaceId: seeded.ws, userId: seeded.user, issueId: issue, action: "create" });
  check(githubMock.issues.length === 2, "C1: 作る操作で Issue ができていない");
  const createdRemote = githubMock.issues.find((item) => item.title === "編集した");
  if (!createdRemote) throw new Error("C1: 新しい Issue のタイトルが違う");
  const link = await q<{ number: number }>(db, "SELECT number FROM github_issue_links WHERE issue_id = ?", issue);
  check(link?.number === createdRemote.number, "C1: 作った Issue と紐づいていない");
  check(!(await q(db, "SELECT issue_id FROM github_issue_create_skips WHERE issue_id = ?", issue)), "C1: 作ったあとも記録が残っている");
}

async function scenarioDeletedUnlink(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 7, title: "消える", description: "本文" });
  const ctx = ctxFor(db, seeded.ws, []);
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 1, "C1: 削除前の Issue がない");
  const number = githubMock.issues[0]?.number;
  githubMock.issues = githubMock.issues.filter((item) => item.number !== number);
  await reconcileIssue(ctx, { issueId: issue });
  check(!(await q(db, "SELECT issue_id FROM github_issue_links WHERE issue_id = ?", issue)), "C1: 削除後も紐づいている");
  check(await q(db, "SELECT issue_id FROM github_issue_create_skips WHERE issue_id = ?", issue), "C1: 削除で外れた記録がない");
  await exec(db, "UPDATE issues SET title = ?, updated_at = ? WHERE id = ?", "削除のあと編集", Date.now(), issue);
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 0, "C1: 削除で外れたあとに Issue を作り直した");
}

async function scenarioEdit(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "88888888-8888-4888-8888-888888888888";
  const comment = "99999999-9999-4999-8999-999999999999";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 4, title: "編集", description: "本文" });
  await insertLink(db, seeded.ws, issue, githubMock.repos.get("acme/widgets")!.id, 9);
  await insertComment(db, { id: comment, ws: seeded.ws, issue, user: seeded.user, body: "編集後の本文", edited: true });
  const ctx = ctxFor(db, seeded.ws, []);
  await pushComment(ctx, comment);
  check(githubMock.comments.length === 1, "A5: 編集後の本文が送られていない");
  check(githubMock.comments[0]?.body.includes("編集後の本文") === true, "A5: 本文が編集前のまま");
  await exec(db, "UPDATE comments SET body = ?, edited_at = ? WHERE id = ?", "送ったあとの編集", Date.now(), comment);
  await pushComment(ctx, comment);
  check(githubMock.comments.length === 1, "A5: 送ったあとの編集でコメントが増えた");
  check(githubMock.comments[0]?.body.includes("送ったあとの編集") === false, "A5: 送ったあとの編集が届いた");
  check(githubMock.comments[0]?.body.includes("編集後の本文") === true, "A5: 最初に送った本文が残っていない");
}

async function scenarioLong(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const comment = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const body = "あ".repeat(MARKDOWN_MAX_LENGTH);
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 5, title: "長い", description: "本文" });
  await insertLink(db, seeded.ws, issue, githubMock.repos.get("acme/widgets")!.id, 11);
  await insertComment(db, { id: comment, ws: seeded.ws, issue, user: seeded.user, body });
  await pushComment(ctxFor(db, seeded.ws, []), comment);
  const posted = githubMock.comments[0]?.body ?? "";
  check(posted.length > 0 && posted.length <= MARKDOWN_MAX_LENGTH, `A6: 長さが上限を超えた (${posted.length})`);
  check(posted.includes("…（長いため一部を省きました。全文は Sen にあります）"), "A6: 省いた旨がない");
  check(posted.includes(`<!-- sen:comment:${comment} -->`), "A6: 印がない");
}

function pushMockComment(number: number, body: string, login = "ghost") {
  const now = new Date().toISOString();
  const comment = {
    id: githubMock.nextCommentId++,
    fullName: "acme/widgets",
    number,
    body,
    user: { login },
    created_at: now,
    updated_at: now,
  };
  githubMock.comments.push(comment);
  return comment;
}

function holdGet(path: string): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  githubMock.hold = { method: "GET", path, entered, gate };
  return { entered: enteredPromise, release };
}

function failNextLinkInsert(db: D1Database): D1Database {
  let armed = true;
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...params: unknown[]) {
          const bound = statement.bind(...params);
          return new Proxy(bound, {
            get(target, prop, receiver) {
              if (prop === "run") {
                return async () => {
                  if (armed && sql.includes("INSERT INTO github_issue_links")) {
                    armed = false;
                    throw new Error("link insert failed once");
                  }
                  return target.run();
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  } as unknown as D1Database;
}

async function scenarioMissedComments(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const number = pushRemote("取り込み中の Issue", "GitHub の本文");
  const repo = githubMock.repos.get("acme/widgets")!;
  for (let i = 0; i < 100; i++) pushMockComment(number, `<!-- sen:comment:own-${i} --> 自分のコメント`);
  const kept = pushMockComment(number, "取り込み前のコメント", "ghost");
  pushMockComment(number, "   ");
  const ctx = ctxFor(db, seeded.ws, []);
  await pullComment(ctx, {
    action: "created",
    comment: {
      id: kept.id,
      body: kept.body,
      html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${kept.id}`,
      created_at: kept.created_at,
      user: kept.user,
    },
    issue: { number },
    repository: { id: repo.id, full_name: "acme/widgets" },
    sender: kept.user,
  });
  check(!(await q(db, "SELECT id FROM comments WHERE body = ?", kept.body)), "E1: 紐づけ前なのにコメントが入った");
  await reconcileIssue(ctx, { repoId: repo.id, number });
  const row = await q<{ id: string }>(db, "SELECT id FROM comments WHERE body = ?", kept.body);
  check(!!row, "E1: 新しく取り込んだ Issue のコメントが入っていない");
  const count = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments");
  check(count?.n === 1, `E1: 自分のコメントか空のコメントが入った (${count?.n})`);
  check(
    githubMock.requests.some((item) => item.method === "GET" && item.path === `/repos/acme/widgets/issues/${number}/comments` && item.search.includes("page=2")),
    "E1: コメントの 2 ページ目を読んでいない",
  );
  await reconcileIssue(ctx, { repoId: repo.id, number });
  const again = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments WHERE body = ?", kept.body);
  check(again?.n === 1, "E1: コメントが二重になった");

  await resetRows(db);
  const later = pushRemote("紐づけをやり直す Issue", "本文");
  const late = pushMockComment(later, "やり直しのあいだのコメント");
  const wrapped = failNextLinkInsert(db);
  const failing = ctxFor(wrapped, seeded.ws, []);
  let failed = false;
  try {
    await reconcileIssue(failing, { repoId: repo.id, number: later });
  } catch (e) {
    failed = e instanceof Error && e.message === "link insert failed once";
  }
  check(failed, "E1: 既存の課題へ紐づける前に失敗していない");
  await pullComment(ctx, {
    action: "created",
    comment: {
      id: late.id,
      body: late.body,
      html_url: `https://github.com/acme/widgets/issues/${later}#issuecomment-${late.id}`,
      created_at: late.created_at,
      user: late.user,
    },
    issue: { number: later },
    repository: { id: repo.id, full_name: "acme/widgets" },
    sender: late.user,
  });
  check(!(await q(db, "SELECT id FROM comments WHERE body = ?", late.body)), "E1: 紐づけ前のやり直しでコメントが入った");
  await reconcileIssue(ctx, { repoId: repo.id, number: later });
  const linked = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues WHERE title = ?", "紐づけをやり直す Issue");
  check(linked?.n === 1, "E1: 既存の課題が二重になった");
  check(!!(await q(db, "SELECT id FROM comments WHERE body = ?", late.body)), "E1: 既存の課題へ紐づけたときコメントが入っていない");
}

async function scenarioDecoyIssue(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "12121212-1212-4212-8212-121212121212";
  const title = "取り違えない Issue";
  const description = "同じ本文";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 8, title, description });
  const decoyAt = new Date(Date.now() - 59_000).toISOString();
  githubMock.issues.push({
    id: githubMock.nextIssueId++,
    number: 70,
    fullName: "acme/widgets",
    title,
    body: description,
    state: "open",
    state_reason: null,
    labels: [],
    assignees: [],
    created_at: decoyAt,
    updated_at: new Date().toISOString(),
    user: { login: "sen-bot" },
  });
  const ctx = ctxFor(db, seeded.ws, []);
  githubMock.loseOnce = { method: "POST", suffix: "/issues" };
  let lost = false;
  try {
    await reconcileIssue(ctx, { issueId: issue });
  } catch {
    lost = true;
  }
  check(lost, "E2: 応答の喪失で失敗していない");
  check(githubMock.issues.length === 2, "E2: 新しい Issue ができていない");
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 2, "E2: やり直しで Issue が増えた");
  const link = await q<{ number: number }>(db, "SELECT number FROM github_issue_links WHERE issue_id = ?", issue);
  const created = githubMock.issues.find((item) => item.number !== 70);
  check(link?.number === created?.number, `E2: 新しく作った Issue と紐づいていない (${link?.number})`);
  check(link?.number !== 70, "E2: 試行の 1 分前の Issue を取り違えた");
}

async function scenarioImportSkip(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const repo = githubMock.repos.get("acme/widgets")!;
  const senIssue = "14141414-1414-4414-8414-141414141414";
  await insertIssue(db, {
    id: senIssue,
    ws: seeded.ws,
    team: seeded.team,
    state: seeded.state,
    user: seeded.user,
    number: 9,
    title: "Sen から作って外す",
    description: "Sen の本文",
  });
  const ctx = ctxFor(db, seeded.ws, []);
  await reconcileIssue(ctx, { issueId: senIssue });
  const senRemote = githubMock.issues.find((item) => item.title === "Sen から作って外す");
  if (!senRemote) throw new Error("E3: Sen の Issue ができていない");
  const importedNumber = pushRemote("GitHub から取り込んで外す", "GitHub の本文");
  await reconcileIssue(ctx, { repoId: repo.id, number: importedNumber });
  const before = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues");
  await runManual(ctx, { workspaceId: seeded.ws, userId: seeded.user, issueId: senIssue, action: "unlink" });
  const imported = await q<{ id: string }>(db, "SELECT id FROM issues WHERE title = ?", "GitHub から取り込んで外す");
  if (!imported) throw new Error("E3: 取り込んだ課題が無い");
  await runManual(ctx, { workspaceId: seeded.ws, userId: seeded.user, issueId: imported.id, action: "unlink" });
  check(!!(await q(db, "SELECT repo_id FROM github_import_skips WHERE repo_id = ? AND number = ?", repo.id, senRemote.number)), "E3: Sen 側の取り込み禁止が無い");
  check(!!(await q(db, "SELECT repo_id FROM github_import_skips WHERE repo_id = ? AND number = ?", repo.id, importedNumber)), "E3: GitHub 側の取り込み禁止が無い");
  senRemote.title = "編集した Sen の Issue";
  senRemote.updated_at = new Date().toISOString();
  const importedRemote = githubMock.issues.find((item) => item.number === importedNumber);
  if (!importedRemote) throw new Error("E3: 取り込んだ Issue が無い");
  importedRemote.title = "編集した GitHub の Issue";
  importedRemote.updated_at = new Date().toISOString();
  await reconcileIssue(ctx, { repoId: repo.id, number: senRemote.number });
  await reconcileIssue(ctx, { repoId: repo.id, number: importedNumber });
  const after = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues");
  check(after?.n === before?.n, `E3: 編集で課題が増えた (${after?.n})`);
  check(!(await q(db, "SELECT issue_id FROM github_issue_links")), "E3: 編集で紐づけが戻った");
  await runManual(ctx, { workspaceId: seeded.ws, userId: seeded.user, issueId: senIssue, action: "link", ref: String(senRemote.number), prefer: "sen" });
  await runManual(ctx, { workspaceId: seeded.ws, userId: seeded.user, issueId: imported.id, action: "link", ref: String(importedNumber), prefer: "github" });
  const senLink = await q<{ number: number }>(db, "SELECT number FROM github_issue_links WHERE issue_id = ?", senIssue);
  const ghLink = await q<{ number: number }>(db, "SELECT number FROM github_issue_links WHERE issue_id = ?", imported.id);
  check(senLink?.number === senRemote.number, "E3: Sen の課題を指定しても紐づかない");
  check(ghLink?.number === importedNumber, "E3: 取り込んだ課題を指定しても紐づかない");
  check(!(await q(db, "SELECT repo_id FROM github_import_skips WHERE repo_id = ? AND number = ?", repo.id, senRemote.number)), "E3: 指定したあとも Sen の記録が残っている");
  check(!(await q(db, "SELECT repo_id FROM github_import_skips WHERE repo_id = ? AND number = ?", repo.id, importedNumber)), "E3: 指定したあとも GitHub の記録が残っている");
  check(after?.n === (await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues"))?.n, "E3: 指定したときに課題が増えた");
}

async function scenarioSentBase(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "13131313-1313-4313-8313-131313131313";
  const title = "送ったあとの説明";
  const number = pushRemote(title, "A");
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 10, title, description: "B" });
  await insertLink(db, seeded.ws, issue, githubMock.repos.get("acme/widgets")!.id, number);
  await exec(db, "UPDATE github_issue_links SET base_title = ?, base_body = ? WHERE issue_id = ?", title, "A", issue);
  const ctx = ctxFor(db, seeded.ws, []);
  const held = holdGet(`/repos/acme/widgets/issues/${number}`);
  const running = reconcileIssue(ctx, { issueId: issue });
  const entered = await Promise.race([
    held.entered.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!entered) {
    held.release();
    throw new Error("E4: Issue の取得が止まれなかった");
  }
  await exec(db, "UPDATE issues SET description = ?, updated_at = ? WHERE id = ?", "C", Date.now() + 5, issue);
  held.release();
  await running;
  const remote = githubMock.issues.find((item) => item.number === number);
  check(remote?.body === "B", `E4: 送った説明が GitHub に無い (${remote?.body})`);
  const base = await q<{ base_body: string }>(db, "SELECT base_body FROM github_issue_links WHERE issue_id = ?", issue);
  check(base?.base_body === "B", `E4: 送った説明が base に無い (${base?.base_body})`);
  check((await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments"))?.n === 0, "E4: 送った直後に衝突のコメントができた");
  await reconcileIssue(ctx, { issueId: issue });
  check(remote?.body === "C", `E4: 次の突き合わせで新しい説明が届いていない (${remote?.body})`);
  check((await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments"))?.n === 0, "E4: 次の突き合わせで衝突のコメントができた");
  const sen = await q<{ description: string }>(db, "SELECT description FROM issues WHERE id = ?", issue);
  check(sen?.description === "C", "E4: Sen の説明が戻った");
}

async function scenarioWebhookBeforeRetry(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "15151515-1515-4515-8515-151515151515";
  const title = "応答の前に届く Issue";
  const description = "同じ本文のまま";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 15, title, description });
  const ctx = ctxFor(db, seeded.ws, []);
  const before = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues");
  githubMock.loseOnce = { method: "POST", suffix: "/issues" };
  let lost = false;
  try {
    await reconcileIssue(ctx, { issueId: issue });
  } catch {
    lost = true;
  }
  check(lost, "F3: 応答の喪失で失敗していない");
  check(githubMock.issues.length === 1, "F3: Issue が 1 件ではない");
  const number = githubMock.issues[0]?.number;
  if (number == null) throw new Error("F3: 作った Issue の番号が無い");
  await reconcileIssue(ctx, { repoId: seeded.repo, number });
  const after = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM issues");
  check(after?.n === before?.n, `F3: Webhook で課題が増えた (${after?.n})`);
  const link = await q<{ number: number }>(db, "SELECT number FROM github_issue_links WHERE issue_id = ?", issue);
  check(link?.number === number, `F3: 元の課題が紐づいていない (${link?.number})`);
  check(!(await q(db, "SELECT target_id FROM github_sync_attempts WHERE kind = 'issue' AND target_id = ?", issue)), "F3: 試行の記録が残っている");
  await reconcileIssue(ctx, { issueId: issue });
  check(githubMock.issues.length === 1, "F3: やり直しで Issue が増えた");
  check(posts("/issues") === 1, "F3: POST が 1 回ではない");
}

async function scenarioImportCommentRetry(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const number = pushRemote("コメントを読み直す Issue", "GitHub の本文");
  const repo = githubMock.repos.get("acme/widgets")!;
  const kept = pushMockComment(number, "読み直すコメント");
  const ctx = ctxFor(db, seeded.ws, []);
  githubMock.failOnce = { method: "GET", suffix: `/issues/${number}/comments` };
  let failed = false;
  try {
    await reconcileIssue(ctx, { repoId: repo.id, number });
  } catch {
    failed = true;
  }
  check(failed, "F2: コメントの取得が失敗していない");
  const created = await q<{ id: string }>(db, "SELECT id FROM issues WHERE title = ?", "コメントを読み直す Issue");
  if (!created) throw new Error("F2: 課題が作られていない");
  check(!!(await q(db, "SELECT issue_id FROM github_issue_links WHERE issue_id = ?", created.id)), "F2: 紐づいていない");
  check(
    !!(await q(db, "SELECT target_id FROM github_sync_attempts WHERE kind = 'import-comments' AND target_id = ?", created.id)),
    "F2: 印が無い",
  );
  check(!(await q(db, "SELECT id FROM comments WHERE body = ?", kept.body)), "F2: 失敗の時点でコメントが入った");
  await reconcileIssue(ctx, { repoId: repo.id, number });
  check(!!(await q(db, "SELECT id FROM comments WHERE body = ?", kept.body)), "F2: やり直しでコメントが入っていない");
  const count = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments WHERE body = ?", kept.body);
  check(count?.n === 1, `F2: コメントが 1 件ではない (${count?.n})`);
  check(
    !(await q(db, "SELECT target_id FROM github_sync_attempts WHERE kind = 'import-comments' AND target_id = ?", created.id)),
    "F2: 印が残っている",
  );
}

async function scenarioBodyConflictKept(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "17171717-1717-4717-8717-171717171717";
  const title = "衝突して残す説明";
  const githubBody = "GitHub にしか無い説明";
  const number = pushRemote(title, githubBody);
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 16, title, description: "Sen に残す説明" });
  await insertLink(db, seeded.ws, issue, githubMock.repos.get("acme/widgets")!.id, number);
  await exec(db, "UPDATE github_issue_links SET base_title = ?, base_body = ? WHERE issue_id = ?", title, "最初の説明", issue);
  const ctx = ctxFor(db, seeded.ws, []);
  const held = holdGet(`/repos/acme/widgets/issues/${number}`);
  const running = reconcileIssue(ctx, { issueId: issue });
  const entered = await Promise.race([
    held.entered.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!entered) {
    held.release();
    throw new Error("F5: Issue の取得が止まれなかった");
  }
  try {
    await exec(db, "UPDATE issues SET description = ?, updated_at = ? WHERE id = ?", "あとから変えた説明", Date.now() + 5, issue);
    held.release();
    await running;
  } finally {
    held.release();
  }
  const note = "GitHub 側の説明と同時に変わったため";
  const conflictCount = async () =>
    (await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments WHERE body LIKE ?", `%${githubBody}%`))?.n;
  check((await conflictCount()) === 1, `F5: 衝突のコメントが 1 件ではない (${await conflictCount()})`);
  const saved = await q<{ body: string }>(db, "SELECT body FROM comments WHERE issue_id = ?", issue);
  check(saved?.body.includes(note) === true && saved.body.includes(githubBody), "F5: GitHub 側の説明がコメントに無い");
  await reconcileIssue(ctx, { issueId: issue });
  const remote = githubMock.issues.find((item) => item.number === number);
  check(remote?.body === "あとから変えた説明", `F5: 次の突き合わせで新しい説明が届いていない (${remote?.body})`);
  check((await conflictCount()) === 1, "F5: 次の突き合わせで衝突のコメントが増えた");

  await resetRows(db);
  const again = "18181818-1818-4818-8818-181818181818";
  const lostBody = "PATCH で失われる説明";
  const lostNumber = pushRemote(title, lostBody);
  await insertIssue(db, { id: again, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 17, title, description: "Sen に残す説明" });
  await insertLink(db, seeded.ws, again, githubMock.repos.get("acme/widgets")!.id, lostNumber);
  await exec(db, "UPDATE github_issue_links SET base_title = ?, base_body = ? WHERE issue_id = ?", title, "最初の説明", again);
  githubMock.failOnce = { method: "PATCH", suffix: `/issues/${lostNumber}` };
  let failed = false;
  try {
    await reconcileIssue(ctx, { issueId: again });
  } catch {
    failed = true;
  }
  check(failed, "F5: PATCH が失敗していない");
  const once = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments WHERE body LIKE ?", `%${lostBody}%`);
  check(once?.n === 1, `F5: 失敗の直後の衝突コメントが 1 件ではない (${once?.n})`);
  await reconcileIssue(ctx, { issueId: again });
  const twice = await q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM comments WHERE body LIKE ?", `%${lostBody}%`);
  check(twice?.n === 1, `F5: やり直しで衝突のコメントが増えた (${twice?.n})`);
  check(githubMock.issues.find((item) => item.number === lostNumber)?.body === "Sen に残す説明", "F5: やり直しで Sen の説明が届いていない");
}

async function scenarioPullAdvance(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  await resetRows(db);
  const issue = "19191919-1919-4919-8919-191919191919";
  await insertIssue(db, { id: issue, ws: seeded.ws, team: seeded.team, state: seeded.state, user: seeded.user, number: 12, title: "PR で動く", description: "" });
  const doing = await q<{ id: string }>(db, "SELECT id FROM workflow_states WHERE team_id = ? AND name = ?", seeded.team, "進行中");
  const done = await q<{ id: string }>(db, "SELECT id FROM workflow_states WHERE team_id = ? AND name = ?", seeded.team, "完了");
  if (!doing || !done) throw new Error("F4: 状態が無い");
  await exec(db, "UPDATE github_repos SET pr_open_state_id = ? WHERE team_id = ?", doing.id, seeded.team);
  const pullNumber = 81;
  const at = new Date().toISOString();
  githubMock.pulls.push({
    id: githubMock.nextPullId++,
    number: pullNumber,
    fullName: "acme/widgets",
    title: "開いた PR",
    body: "RET-12",
    state: "open",
    draft: false,
    merged: false,
    user: { login: "octocat" },
    headRef: "ret-12",
    updated_at: at,
  });
  let stamp = 0;
  const mini = db as unknown as MiniD1;
  mini.afterSql = {
    includes: "SELECT id, team_id, state_id, updated_at FROM issues",
    run: async () => {
      stamp = Date.now() + 60_000;
      await exec(db, "UPDATE issues SET state_id = ?, updated_at = ? WHERE id = ?", done.id, stamp, issue);
    },
  };
  try {
    await syncPull(
      { env: envFor(db), workspaceId: seeded.ws, enqueueIssue: async () => {} },
      {
        action: "opened",
        pull_request: {
          number: pullNumber,
          title: "開いた PR",
          body: "RET-12",
          html_url: `https://github.com/acme/widgets/pull/${pullNumber}`,
          state: "open",
          draft: false,
          merged: false,
          user: { login: "octocat" },
          head: { ref: "ret-12" },
        },
        repository: { id: seeded.repo, full_name: "acme/widgets" },
        sender: { login: "octocat" },
      },
    );
  } finally {
    mini.afterSql = null;
    await exec(db, "UPDATE github_repos SET pr_open_state_id = NULL WHERE team_id = ?", seeded.team);
  }
  check(stamp !== 0, "F4: 課題の読み込みに差し込めていない");
  const after = await q<{ state_id: string; updated_at: number }>(db, "SELECT state_id, updated_at FROM issues WHERE id = ?", issue);
  check(after?.state_id === done.id, "F4: 完了が前の段階に戻った");
  check(after?.updated_at === stamp, `F4: 完了の時刻が上書きされた (${after?.updated_at})`);
}

async function scenarioScheduleError(db: D1Database, seeded: Awaited<ReturnType<typeof seed>>): Promise<void> {
  const env = envFor(db);
  const badEnv = {
    ...env,
    DB: {
      prepare() {
        throw new Error("db down");
      },
    },
  } as unknown as Env;
  let escaped = false;
  try {
    await scheduleGitHubSync(badEnv, { id: seeded.ws, url_key: "retry" } as WorkspaceRow, [{ entity: "comment", entityId: "comment-1", op: "upsert" }], null);
  } catch {
    escaped = true;
  }
  check(!escaped, "E7: コメントの送信予約の失敗が呼び出し元に出た");
}

async function runReconcileAlarm(): Promise<void> {
  resetGitHubMock();
  const server: Server = await startGitHubMock();
  try {
    const db = await openDb();
    const seeded = await seed(db);
    await resetRows(db);
    const repo = githubMock.repos.get("acme/widgets")!;
    const at = new Date().toISOString();
    githubMock.issues.push({
      id: githubMock.nextIssueId++,
      number: 42,
      fullName: "acme/widgets",
      title: "突き合わせで待つ",
      body: "本文",
      state: "open",
      state_reason: null,
      labels: [],
      assignees: [],
      created_at: at,
      updated_at: at,
      user: { login: "someone" },
    });
    githubMock.failOnce = { method: "GET", suffix: "/issues/comments" };
    const storage = memoryStorage();
    let alarm: number | null = null;
    let sync!: GitHubSyncRunner;
    const signal = async () => {
      alarm = await sync.nextAt();
    };
    sync = new GitHubSyncRunner(storage, envFor(db), signal);
    const res = await sync.handle(
      new Request("https://realtime/github/reconcile", { method: "POST", body: JSON.stringify({ workspaceId: seeded.ws }) }),
    );
    check(res?.status === 500, `E9: コメント取得の失敗が 500 になっていない (${res?.status})`);
    const key = `gh:dirty:gh:${repo.id}:42`;
    const item = await storage.get<{ nextAt: number }>(key);
    check(item != null && typeof item.nextAt === "number", "E9: Issue が順番待ちに入っていない");
    const meta = await storage.get<{ nextAt: number | null }>("gh:meta");
    check(meta?.nextAt != null, "E9: 順番待ちの次の時刻が無い");
    check(alarm === meta?.nextAt, "E9: アラームが鳴らない");
    await sync.alarm();
    check((await storage.get(key)) === undefined, "E9: アラームで順番待ちが処理されていない");
    check(!!(await q(db, "SELECT id FROM issues WHERE title = ?", "突き合わせで待つ")), "E9: アラームで課題が取り込まれていない");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function runPullTruncate(): Promise<void> {
  resetGitHubMock();
  const server: Server = await startGitHubMock();
  try {
    const db = await openDb();
    const seeded = await seed(db);
    await resetRows(db);
    const linked = await q<{ linked_at: number }>(db, "SELECT linked_at FROM github_repos WHERE workspace_id = ? AND repo_id = ?", seeded.ws, seeded.repo);
    const linkedAt = linked?.linked_at ?? null;
    check(linkedAt != null, "G1: 連携の時刻が無い");
    const origin = linkedAt ?? 0;
    const previous = new Date(origin).toISOString();
    const count = 3001;
    for (let i = 1; i <= count; i++) {
      const at = new Date(origin + i * 1000).toISOString();
      githubMock.pulls.push({
        id: i,
        number: i,
        fullName: "acme/widgets",
        title: `pull ${i}`,
        body: "",
        state: "open",
        draft: i === 1,
        merged: i === 1,
        user: { login: "octocat" },
        headRef: `branch-${i}`,
        updated_at: at,
        asIssue: true,
      });
    }
    const pulls: { number: number; title: string; draft: boolean; merged: boolean; head: string }[] = [];
    let issueJobs = 0;
    await scanUpdates(
      envFor(db),
      seeded.ws,
      { get: async () => previous, put: async () => {} },
      {
        issue: async () => {
          issueJobs += 1;
        },
        comment: async () => {},
        pull: async (payload) => {
          pulls.push({
            number: payload.pull_request.number,
            title: payload.pull_request.title,
            draft: payload.pull_request.draft,
            merged: payload.pull_request.merged,
            head: payload.pull_request.head.ref,
          });
        },
      },
    );
    const of = (number: number) => pulls.filter((pull) => pull.number === number);
    const oldest = of(1);
    const newest = of(count);
    const both = of(1500);
    check(issueJobs === 0, "G1: PR を課題として順番待ちに入れている");
    check(pulls.length === 6000, `G1: 順番待ちが 6,000 件ではない (${pulls.length})`);
    check(oldest.length === 1, "G1: いちばん古い PR が順番待ちに入っていない");
    check(oldest[0]?.title === "pull 1" && oldest[0]?.draft === true && oldest[0]?.merged === true, "G1: 古い PR を Issue の値から作っていない");
    check(oldest[0]?.head === "", "G1: いちばん古い PR が PR の一覧に入っている");
    check(newest.length === 1 && newest[0]?.head === `branch-${count}`, "G1: 新しい PR が PR の一覧から入っていない");
    check(both.length === 2 && both[0]?.head === "" && both[1]?.head === "branch-1500", "G1: PR の一覧のブランチ名で上書きされる順になっていない");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const job = process.argv.includes("--reconcile-alarm") ? runReconcileAlarm : process.argv.includes("--pull-truncate") ? runPullTruncate : main;
job().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
