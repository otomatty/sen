// ブラウザを使わない。Durable Object のストレージは Map で置き換える。
// drain() の処理中に同じキーへ新しい印が入っても消えないことと、
// 処理が遅くても /github/event がすぐ返ることを確かめる。

import type { Env } from "../env";
import { GitHubSyncRunner, processors } from "./runner";

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

await testNewMarkSurvives();
await testRetryKeepsNewMark();
await testEventReturnsWhileDraining();
await testEarliestNextAt();
await testDrainsDoNotOverlap();
console.log("github runner tests ok");
