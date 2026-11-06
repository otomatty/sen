// Playwright からは bun で起動する。同期の実装は SQL の raw import を含むため、
// Playwright の変換では読めない。ここは待ち時間を使わず、呼び出しの順で確かめる。

import { createRequire } from "node:module";
import type { Server } from "node:http";
import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import { ensureMigrated } from "../../worker/db";
import type { Env } from "../../worker/env";
import { insertTeam } from "../../worker/mutations";
import { pushComment, reconcileIssue, type SyncCtx } from "../../worker/github/sync";
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
    return { results: this.runSync().results as T[] };
  }

  async first<T>() {
    return (this.runSync().results[0] as T | undefined) ?? null;
  }

  async run() {
    this.runSync();
    return { success: true as const, meta: { changes: this.shim.sqlite.getRowsModified() } };
  }
}

class MiniD1 {
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
  for (const table of ["github_comment_links", "github_issue_links", "github_sync_attempts", "comments", "notifications", "activities", "sync_log", "issues"]) {
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
    await scenarioImport(db, seeded);
    await scenarioWaitingComment(db, seeded);
    await scenarioEdit(db, seeded);
    await scenarioLong(db, seeded);
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

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
