// Playwright からは bun で起動する。シートの runner は移行 SQL を読むため、
// Playwright の変換では読めない。Durable Object のアラームは writeAlarm と同じ順で合わせる。

import type { Env } from "../../worker/env";
import { GitHubSyncRunner } from "../../worker/github/runner";
import { SheetSyncRunner } from "../../worker/sheets/runner";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function memoryStorage(): DurableObjectStorage {
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

function pair(storage: DurableObjectStorage, env: Env): { sheets: SheetSyncRunner; github: GitHubSyncRunner; writeAlarm: () => Promise<void> } {
  let sheets!: SheetSyncRunner;
  let github!: GitHubSyncRunner;
  const writeAlarm = async () => {
    const times = [await sheets.nextAt(), await github.nextAt()].filter((time): time is number => time != null);
    if (times.length === 0) {
      await storage.deleteAlarm();
      return;
    }
    await storage.setAlarm(Math.min(...times));
  };
  sheets = new SheetSyncRunner(storage, env, writeAlarm);
  github = new GitHubSyncRunner(storage, env, writeAlarm);
  return { sheets, github, writeAlarm };
}

function mark(issues: string[]): Request {
  return new Request("https://realtime/github/mark", {
    method: "POST",
    body: JSON.stringify({ workspaceId: "ws", issues }),
  });
}

async function legacyKeepsSheetTime(): Promise<void> {
  const clock = { now: 5_000_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const sheetAt = clock.now + 60_000;
    const storage = memoryStorage();
    await storage.put("sheets", {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      retries: 0,
      origin: "http://localhost",
    });
    await storage.setAlarm(sheetAt);
    const { sheets, github } = pair(storage, {} as Env);
    const res = await github.handle(mark(["issue-1"]));
    check(res?.status === 200, "C3: GitHub の予約を受け付けていない");
    const stored = await storage.get<{ nextAt?: unknown }>("sheets");
    check(stored != null && Object.prototype.hasOwnProperty.call(stored, "nextAt"), "C3: nextAt を保存していない");
    check(stored.nextAt === sheetAt, `C3: シートの予約が残っていない (${String(stored.nextAt)})`);
    check((await storage.getAlarm()) === clock.now + 3_000, `C3: アラームが GitHub の時刻ではない (${String(await storage.getAlarm())})`);
    await storage.setAlarm(clock.now + 999_999);
    check((await sheets.nextAt()) === sheetAt, "C3: 移したあとにアラームを読み直している");
  } finally {
    Date.now = realNow;
  }
}

async function legacyWithoutAlarm(): Promise<void> {
  const storage = memoryStorage();
  await storage.put("sheets", { lastAttemptAt: 1, lastSuccessAt: null, lastError: null, retries: 0, origin: null });
  const sheets = new SheetSyncRunner(storage, {} as Env, async () => {});
  check((await sheets.nextAt()) === null, "C3: アラームが無いのに時刻がある");
  const stored = await storage.get<{ nextAt?: unknown }>("sheets");
  check(stored != null && Object.prototype.hasOwnProperty.call(stored, "nextAt") && stored.nextAt === null, "C3: nextAt を null で保存していない");
}

async function clearWithoutGitHub(): Promise<void> {
  const clock = { now: 6_000_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const storage = memoryStorage();
    await storage.put("sheets", {
      lastAttemptAt: clock.now - 1_000,
      lastSuccessAt: null,
      lastError: null,
      retries: 1,
      origin: "http://localhost",
      nextAt: clock.now - 5_000,
    });
    await storage.setAlarm(clock.now - 5_000);
    const { sheets, github, writeAlarm } = pair(storage, {} as Env);
    await sheets.alarm();
    await github.alarm();
    await writeAlarm();
    const stored = await storage.get<{ nextAt: number | null }>("sheets");
    check(stored?.nextAt === null, `C4: nextAt が残っている (${String(stored?.nextAt)})`);
    check((await storage.getAlarm()) === null, "C4: アラームが残っている");
  } finally {
    Date.now = realNow;
  }
}

async function clearKeepsGitHub(): Promise<void> {
  const clock = { now: 7_000_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    const storage = memoryStorage();
    await storage.put("sheets", {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      retries: 0,
      origin: null,
      nextAt: clock.now - 5_000,
    });
    await storage.setAlarm(clock.now - 5_000);
    const { sheets, github, writeAlarm } = pair(storage, {} as Env);
    check((await github.handle(mark(["later"])))?.status === 200, "C4: GitHub の予約を受け付けていない");
    await sheets.alarm();
    await github.alarm();
    await writeAlarm();
    const stored = await storage.get<{ nextAt: number | null }>("sheets");
    check(stored?.nextAt === null, `C4: GitHub の予約があるのにシートの nextAt が残っている (${String(stored?.nextAt)})`);
    check((await storage.getAlarm()) === clock.now + 3_000, `C4: GitHub の予約が消えている (${String(await storage.getAlarm())})`);
  } finally {
    Date.now = realNow;
  }
}

async function main(): Promise<void> {
  await legacyKeepsSheetTime();
  await legacyWithoutAlarm();
  await clearWithoutGitHub();
  await clearKeepsGitHub();
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
