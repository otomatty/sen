// ブラウザを使わない。Durable Object のストレージは Map で置き換える。
// drain() の処理中に同じキーへ新しい印が入っても消えないことと、
// 処理が遅くても /github/event がすぐ返ることを確かめる。

import type { Server } from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import type { Env } from "../../worker/env";
import { getIssue, listComments, listIssues } from "../../worker/github/api";
import type { GitHubConfig } from "../../worker/github/config";
import { GitHubSyncRunner, processors } from "../../worker/github/runner";
import { GITHUB_PORT, GITHUB_TOKEN, addGitHubRepo, githubMock, resetGitHubMock, startGitHubMock } from "./github-mock";

if (process.argv.includes("--alarm-child")) {
  try {
    await runAlarmChild();
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  }
  process.exit(0);
}

const MARK_DELAY_MS = 3_000;
const SLOW_MS = 2_000;

interface Stored {
  token: string;
  attempts: number;
  nextAt: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
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

function post(path: string, body: unknown): Request {
  return new Request(`https://realtime${path}`, { method: "POST", body: JSON.stringify(body) });
}

function runner(storage: DurableObjectStorage, signal: () => Promise<void> = async () => {}): GitHubSyncRunner {
  return new GitHubSyncRunner(storage, {} as Env, signal);
}

/** WorkspaceRealtime のアラーム。シートの時刻は使わず、キー "sheets" は処理のときに消す */
async function runAlarmChild(): Promise<void> {
  const bunTest = (await import("bun:" + "test")) as {
    mock: { module(specifier: string, factory: () => unknown): void };
  };
  bunTest.mock.module("cloudflare:workers", () => ({
    DurableObject: class {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  }));
  const globals = globalThis as typeof globalThis & {
    WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
    __SEN_DEMO__: boolean;
  };
  globals.WebSocketRequestResponsePair = class {
    constructor(_request: string, _response: string) {}
  };
  globals.__SEN_DEMO__ = false;

  const loaded = (await import(new URL("../../worker/index.ts", import.meta.url).href)) as {
    WorkspaceRealtime: new (
      ctx: { storage: DurableObjectStorage; setWebSocketAutoResponse: (pair: unknown) => void },
      env: Env,
    ) => { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };
  };
  const clock = { now: 8_000_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  const saved = processors.issue;
  try {
    const storage = alarmStorage();
    const sheetAt = clock.now + 500;
    await storage.put("sheets", { nextAt: sheetAt, lastAttemptAt: null, lastSuccessAt: null, lastError: null, retries: 0, origin: null });
    await storage.setAlarm(sheetAt);
    const realtime = new loaded.WorkspaceRealtime({ storage, setWebSocketAutoResponse() {} }, {} as Env);
    const marked = await realtime.fetch(
      new Request("https://realtime/github/mark", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws", issues: ["issue-1"] }),
      }),
    );
    assertEqual(marked.status, 200);
    const meta = await storage.get<{ nextAt: number | null }>("gh:meta");
    assert(meta?.nextAt != null, "GitHub の nextAt が無い");
    assertEqual(await storage.getAlarm(), meta.nextAt);
    assert(meta.nextAt !== sheetAt, "アラームが以前の連携の時刻に合っている");
    assert((await storage.get("sheets")) != null, "処理の前に sheets が消えている");

    let ran = 0;
    processors.issue = async () => {
      ran += 1;
    };
    await realtime.alarm();
    assertEqual(ran, 0);
    assertEqual(await storage.get("sheets"), undefined);
    assert(await storage.get("gh:dirty:issue:issue-1"), "期限前の順番待ちが消えている");
    const waiting = await storage.get<{ nextAt: number | null }>("gh:meta");
    assertEqual(await storage.getAlarm(), waiting?.nextAt ?? null);

    clock.now = meta.nextAt;
    await realtime.alarm();
    assertEqual(ran, 1);
    assertEqual(await storage.get("sheets"), undefined);
    assertEqual(await storage.get("gh:dirty:issue:issue-1"), undefined);
    assertEqual(await storage.getAlarm(), null);
  } finally {
    processors.issue = saved;
    Date.now = realNow;
  }
}

function alarmStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
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
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => {
      alarm = time;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  } as unknown as DurableObjectStorage;
}

async function withProcessors(fn: () => Promise<void>): Promise<void> {
  const saved = {
    issue: processors.issue,
    githubIssue: processors.githubIssue,
    comment: processors.comment,
    githubComment: processors.githubComment,
    pull: processors.pull,
  };
  try {
    await fn();
  } finally {
    Object.assign(processors, saved);
  }
}

function hold(): { blocked: Promise<void>; release: () => void; started: Promise<void>; markStarted: () => void } {
  let release!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return { blocked, release, started, markStarted };
}

async function testNewMarkSurvives(): Promise<void> {
  await withProcessors(async () => {
    const clock = { now: 1_700_000_000_000 };
    const realNow = Date.now;
    Date.now = () => clock.now;
    const held = hold();
    let calls = 0;
    const storage = memoryStorage();
    const sync = runner(storage);
    const key = "gh:dirty:issue:issue-1";
    const mark = () => post("/github/mark", { workspaceId: "ws", issues: ["issue-1"] });
    let draining = Promise.resolve();
    try {
      processors.issue = async () => {
        calls += 1;
        if (calls === 1) {
          held.markStarted();
          await held.blocked;
        }
      };
      assertEqual((await sync.handle(mark()))?.status, 200);
      const first = await storage.get<Stored>(key);
      assert(first, "最初の印がない");
      clock.now += MARK_DELAY_MS;

      draining = sync.alarm();
      await held.started;
      const pending = sync.handle(mark());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const winner = await Promise.race([
        pending.then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 500);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      assertEqual(winner, "done");
      const fresh = await storage.get<Stored>(key);
      assert(fresh, "新しい印がない");
      assert(fresh.token !== first.token, "印の token が変わっていない");
      assertEqual(fresh.attempts, 0);

      held.release();
      await draining;
      const kept = await storage.get<Stored>(key);
      assert(kept, "処理後に新しい印が消えている");
      assertEqual(kept.token, fresh.token);
      assertEqual(kept.attempts, 0);

      clock.now += MARK_DELAY_MS;
      await sync.alarm();
      assertEqual(calls, 2);
      assertEqual(await storage.get(key), undefined);
    } finally {
      held.release();
      await draining;
      Date.now = realNow;
    }
  });
}

async function testRetryKeepsNewMark(): Promise<void> {
  await withProcessors(async () => {
    const clock = { now: 1_700_000_000_000 };
    const realNow = Date.now;
    const realError = console.error;
    Date.now = () => clock.now;
    console.error = () => {};
    const held = hold();
    let calls = 0;
    const storage = memoryStorage();
    const sync = runner(storage);
    const key = "gh:dirty:issue:issue-1";
    const mark = () => post("/github/mark", { workspaceId: "ws", issues: ["issue-1"] });
    let draining = Promise.resolve();
    try {
      processors.issue = async () => {
        calls += 1;
        if (calls === 1) {
          held.markStarted();
          await held.blocked;
          throw new Error("sync failed");
        }
      };
      assertEqual((await sync.handle(mark()))?.status, 200);
      clock.now += MARK_DELAY_MS;
      draining = sync.alarm();
      await held.started;
      assertEqual((await sync.handle(mark()))?.status, 200);
      const fresh = await storage.get<Stored>(key);
      assert(fresh, "新しい印がない");
      held.release();
      await draining;
      const kept = await storage.get<Stored>(key);
      assert(kept, "失敗のあと新しい印が消えている");
      assertEqual(kept.token, fresh.token);
      assertEqual(kept.attempts, 0);

      clock.now += MARK_DELAY_MS;
      await sync.alarm();
      assertEqual(calls, 2);
      assertEqual(await storage.get(key), undefined);
    } finally {
      held.release();
      await draining;
      Date.now = realNow;
      console.error = realError;
    }
  });
}

async function testEventReturnsWhileDraining(): Promise<void> {
  await withProcessors(async () => {
    const held = hold();
    let runs = 0;
    let finished = false;
    const storage = memoryStorage();
    const sync = runner(storage);
    processors.githubIssue = async () => {
      runs += 1;
      if (runs === 1) {
        held.markStarted();
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        finished = true;
      }
    };
    const event = (number: number) =>
      post("/github/event", { workspaceId: "ws", incoming: { type: "issue", repoId: 4, number } });
    assertEqual((await sync.handle(event(1)))?.status, 200);
    const draining = sync.alarm();
    await held.started;
    try {
      const started = Date.now();
      const res = await sync.handle(event(2));
      const elapsed = Date.now() - started;
      assertEqual(res?.status, 200);
      assertEqual(finished, false);
      assert(elapsed < SLOW_MS / 2, `/github/event が ${elapsed}ms 待った`);
      const queued = await storage.get<Stored>("gh:dirty:gh:4:2");
      assert(queued, "受け付けた出来事がストレージに無い");
      assertEqual(queued.attempts, 0);
      assertEqual(typeof queued.token, "string");
    } finally {
      await draining;
    }
  });
}

async function testEarliestNextAt(): Promise<void> {
  const clock = { now: 5_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const storage = memoryStorage();
    const seen: number[] = [];
    const sync = runner(storage, async () => {
      const next = await sync.nextAt();
      if (next != null) seen.push(next);
    });
    await Promise.all([
      sync.handle(post("/github/mark", { workspaceId: "ws", issues: ["late"] })),
      sync.handle(post("/github/event", { workspaceId: "ws", incoming: { type: "issue", repoId: 9, number: 9 } })),
    ]);
    assertEqual(await sync.nextAt(), clock.now);
    assert(seen.includes(clock.now), `アラームが早い時刻に合っていない: ${seen.join(",")}`);
  } finally {
    Date.now = realNow;
  }
}

async function testDrainsDoNotOverlap(): Promise<void> {
  await withProcessors(async () => {
    const held = hold();
    let active = 0;
    let max = 0;
    const storage = memoryStorage();
    const sync = runner(storage);
    processors.githubIssue = async () => {
      active += 1;
      max = Math.max(max, active);
      held.markStarted();
      await held.blocked;
      active -= 1;
    };
    assertEqual(
      (await sync.handle(post("/github/event", { workspaceId: "ws", incoming: { type: "issue", repoId: 1, number: 1 } })))?.status,
      200,
    );
    const first = sync.alarm();
    try {
      await held.started;
      const second = sync.alarm();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEqual(active, 1);
      assertEqual(max, 1);
      held.release();
      await first;
      await second;
      assertEqual(max, 1);
    } finally {
      held.release();
      await first;
    }
  });
}

test("順番待ちは印を消さず、受け付けは処理を待たない", async () => {
  await testNewMarkSurvives();
  await testRetryKeepsNewMark();
  await testEventReturnsWhileDraining();
  await testEarliestNextAt();
  await testDrainsDoNotOverlap();
});

test("送信と取り込みのやり直しは重複も消失もしない", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const run = spawnSync("bun", ["tests/e2e/github-sync-retry.ts"], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error([run.stdout, run.stderr].filter(Boolean).join("\n"));
});

test("アラームは GitHub の nextAt だけに合い、以前の連携の状態は消える", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const run = spawnSync("bun", ["tests/e2e/github-runner.spec.ts", "--alarm-child"], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error([run.stdout, run.stderr].filter(Boolean).join("\n"));
});

test("二次レート制限は権限エラーにせず、retry-after まで待つ", async () => {
  resetGitHubMock();
  const server: Server = await startGitHubMock();
  const clock = { now: 1_700_000_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    await withProcessors(async () => {
      processors.githubIssue = async () => {
        await getIssue(
          {
            workspaceKey: "runner",
            token: GITHUB_TOKEN,
            webhookSecret: "runner-secret",
            delayMs: 0,
            apiOrigin: `http://127.0.0.1:${GITHUB_PORT}`,
          },
          "acme",
          "widgets",
          1,
        );
      };
      githubMock.respondOnce = { method: "GET", suffix: "/issues/1", status: 403, headers: { "retry-after": "30" } };
      const storage = memoryStorage();
      let alarm: number | null = null;
      let sync!: GitHubSyncRunner;
      const signal = async () => {
        alarm = await sync.nextAt();
      };
      sync = new GitHubSyncRunner(storage, {} as Env, signal);
      const key = "gh:dirty:gh:1000:1";
      assertEqual(
        (
          await sync.handle(
            post("/github/event", { workspaceId: "ws", incoming: { type: "issue", repoId: 1000, number: 1 } }),
          )
        )?.status,
        200,
      );
      await sync.alarm();
      const item = await storage.get<{ attempts: number; nextAt: number }>(key);
      const meta = await storage.get<{ error: string | null; rateLimitReset: number | null; nextAt: number | null }>("gh:meta");
      assertEqual(item?.attempts, 1);
      assertEqual(meta?.error, "GitHub の利用制限に達しました");
      assert(meta?.error !== "GitHub の権限がありません", "権限エラーになっている");
      assertEqual(meta?.rateLimitReset, clock.now + 30_000);
      assertEqual(item?.nextAt, clock.now + 30_000);
      assertEqual(alarm, meta?.nextAt);
      await sync.alarm();
      assertEqual((await storage.get<{ attempts: number }>(key))?.attempts, 1);
    });
  } finally {
    Date.now = realNow;
    resetGitHubMock();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

async function waitUntilRateLimitReset(status: 403 | 429): Promise<void> {
  resetGitHubMock();
  const server: Server = await startGitHubMock();
  const clock = { now: 1_700_000_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    await withProcessors(async () => {
      processors.githubIssue = async () => {
        await getIssue(
          {
            workspaceKey: "runner",
            token: GITHUB_TOKEN,
            webhookSecret: "runner-secret",
            delayMs: 0,
            apiOrigin: `http://127.0.0.1:${GITHUB_PORT}`,
          },
          "acme",
          "widgets",
          1,
        );
      };
      const resetSec = Math.floor(clock.now / 1000) + 90;
      const headers: Record<string, string> = { "x-ratelimit-reset": String(resetSec) };
      if (status === 403) headers["x-ratelimit-remaining"] = "0";
      githubMock.respondOnce = { method: "GET", suffix: "/issues/1", status, headers };
      const storage = memoryStorage();
      let alarm: number | null = null;
      let sync!: GitHubSyncRunner;
      const signal = async () => {
        alarm = await sync.nextAt();
      };
      sync = new GitHubSyncRunner(storage, {} as Env, signal);
      const key = "gh:dirty:gh:1000:1";
      assertEqual(
        (
          await sync.handle(
            post("/github/event", { workspaceId: "ws", incoming: { type: "issue", repoId: 1000, number: 1 } }),
          )
        )?.status,
        200,
      );
      await sync.alarm();
      const item = await storage.get<{ attempts: number; nextAt: number }>(key);
      const meta = await storage.get<{ error: string | null; rateLimitReset: number | null; nextAt: number | null }>("gh:meta");
      assertEqual(item?.attempts, 1);
      assertEqual(meta?.error, "GitHub の利用制限に達しました");
      assert(meta?.error !== "GitHub の権限がありません", "権限エラーになっている");
      assertEqual(meta?.rateLimitReset, resetSec * 1000);
      assertEqual(item?.nextAt, resetSec * 1000);
      assertEqual(alarm, meta?.nextAt);
      await sync.alarm();
      assertEqual((await storage.get<{ attempts: number }>(key))?.attempts, 1);
    });
  } finally {
    Date.now = realNow;
    resetGitHubMock();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("retry-after が無い残り回数 0 の 403 は x-ratelimit-reset まで待つ", async () => {
  await waitUntilRateLimitReset(403);
});

test("retry-after が無い 429 は x-ratelimit-reset まで待つ", async () => {
  await waitUntilRateLimitReset(429);
});

test("突き合わせが途中で失敗しても、入れた順番待ちのアラームが鳴る", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const run = spawnSync("bun", ["tests/e2e/github-sync-retry.ts", "--reconcile-alarm"], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error([run.stdout, run.stderr].filter(Boolean).join("\n"));
});

test("Issue とコメントの一覧は古い順に 3,000 件で打ち切る", async () => {
  resetGitHubMock();
  const server: Server = await startGitHubMock();
  try {
    const cfg: GitHubConfig = {
      workspaceKey: "runner",
      token: GITHUB_TOKEN,
      webhookSecret: "runner-secret",
      delayMs: 0,
      apiOrigin: `http://127.0.0.1:${GITHUB_PORT}`,
    };
    addGitHubRepo("acme/tiny");
    const tinyAt = "2024-01-01T00:00:00.000Z";
    githubMock.issues.push(mockIssue(1, "acme/tiny", tinyAt));
    githubMock.comments.push(mockComment(1, 1, "acme/tiny", tinyAt, "ひとつ"));
    const tinyIssues = await listIssues(cfg, "acme", "tiny", "2020-01-01T00:00:00.000Z");
    assert(!tinyIssues.truncated, "1 件で打ち切っている");
    assertEqual(tinyIssues.items.length, 1);
    const tinyComments = await listComments(cfg, "acme", "tiny", "2020-01-01T00:00:00.000Z");
    assert(!tinyComments.truncated, "コメント 1 件で打ち切っている");
    assertEqual(tinyComments.items.length, 1);

    const base = Date.parse("2024-06-01T00:00:00.000Z");
    for (let i = 1; i <= 3001; i++) {
      const at = new Date(base + i * 1000).toISOString();
      githubMock.issues.push(mockIssue(i, "acme/widgets", at));
      githubMock.comments.push(mockComment(i, i, "acme/widgets", at, `c${i}`));
    }
    const issues = await listIssues(cfg, "acme", "widgets", "2020-01-01T00:00:00.000Z");
    assert(issues.truncated, "Issue を打ち切っていない");
    assertEqual(issues.items.length, 3000);
    assertEqual(issues.items[0]?.number, 1);
    assertEqual(issues.items[2999]?.number, 3000);
    assert(!issues.items.some((issue) => issue.number === 3001), "3001 件目まで読んでいる");
    const comments = await listComments(cfg, "acme", "widgets", "2020-01-01T00:00:00.000Z");
    assert(comments.truncated, "コメントを打ち切っていない");
    assertEqual(comments.items.length, 3000);
    assertEqual(comments.items[0]?.id, 1);
    assertEqual(comments.items[2999]?.id, 3000);
    assert(!comments.items.some((comment) => comment.id === 3001), "3001 件目のコメントまで読んでいる");
    const listed = githubMock.requests.filter((item) => item.method === "GET" && item.path === "/repos/acme/widgets/issues");
    assert(listed.some((item) => item.search.includes("sort=updated") && item.search.includes("direction=asc")), "古い順で読んでいない");
  } finally {
    resetGitHubMock();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

function mockIssue(number: number, fullName: string, updatedAt: string) {
  return {
    id: number,
    number,
    fullName,
    title: `issue ${number}`,
    body: "",
    state: "open" as const,
    state_reason: null,
    labels: [],
    assignees: [],
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function mockComment(id: number, number: number, fullName: string, updatedAt: string, body: string) {
  return {
    id,
    fullName,
    number,
    body,
    user: { login: "ghost" },
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}
