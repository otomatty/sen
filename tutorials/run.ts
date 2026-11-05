/**
 * 操作説明動画の自動収録
 *
 *   bun run tutorials                 # すべて収録
 *   bun run tutorials -- create board # id の一部で絞り込み
 *   bun run tutorials -- --skip-build # ビルドを省略
 *   bun run tutorials -- --url https://xxx.workers.dev  # 既存の環境で収録（DEV_TOOLS=1 が必要）
 *   bun run tutorials -- --no-narration       # ナレーションなしで撮る
 *   bun run tutorials -- --speed 0.8          # 操作の速さ（1 が標準。0.8 なら 2 割ゆっくり）
 *
 * 流れ: アプリをビルド → まっさらな DB でローカル起動 → デモデータを投入 →
 *       ヘッドレス Chromium で各シナリオを AI（スクリプト）が操作 → CDP で録画 → ffmpeg で MP4 化 →
 *       public/tutorials/ に動画・サムネイル・manifest.json を書き出す
 *
 * スプレッドシート連携のシナリオ（export const sheets = true）は、データの初期化のあとで
 * 模擬の Google に向けてサーバーを起動し直してから撮る。--url では撮れない。
 */
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, request, type APIRequestContext, type Browser } from "playwright";
import { googleMock, TUTORIAL_SHEETS_DELAY_MS, TUTORIAL_SPREADSHEET_ID } from "./lib/google-mock";
import { overlayScript } from "./lib/overlay";
import { ScreenRecorder } from "./lib/recorder";
import { Director, PARK } from "./lib/director";
import { Narrator, collectNarrationTexts, muxNarration, titleNarration } from "./lib/narration";
import type { Scenario } from "./lib/types";
import { sourceHash } from "./lib/source-hash";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "tutorials");
const WORK_DIR = path.join(os.tmpdir(), "sen-tutorials");
const DEV_VARS = path.join(ROOT, "dist", "sen", ".dev.vars");
const PORT = Number(process.env.TUTORIAL_PORT ?? 4319);
const GOOGLE_PORT = Number(process.env.TUTORIAL_GOOGLE_PORT ?? 4339);
const TUTORIALS_BEGIN = "# >>> tutorials（収録が自動で書き足す。収録のたびに書き直す）";
const TUTORIALS_END = "# <<< tutorials";
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 1.5;
const VIDEO_WIDTH = 1600;
const ACCENT = "#6470e8";
const USER = { name: "山田 太郎", email: "taro@example.com", workspaceName: "ミライ株式会社" };

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const keepFrames = args.includes("--keep-frames");
const noNarration = args.includes("--no-narration");
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
const speed = parseSpeed(args);
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url" && args[i - 1] !== "--speed");

/** --speed の次の値。正の数でなければ終了する（1 が標準。0.8 なら 2 割ゆっくり） */
function parseSpeed(argv: string[]): number {
  const i = argv.indexOf("--speed");
  if (i < 0) return 1;
  const raw = argv[i + 1];
  const value = Number(raw);
  if (raw == null || !Number.isFinite(value) || value <= 0) {
    console.error("--speed には正の数を指定してください（1 が標準です。0.8 なら 2 割ゆっくり）");
    process.exit(1);
  }
  return value;
}

function log(msg: string) {
  console.log(`\x1b[36m[tutorials]\x1b[0m ${msg}`);
}

async function waitForServer(base: string, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      // 起動待ち
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("サーバーが起動しませんでした");
}

/** /api/health に繋がらなくなるまで待つ（--strictPort なので、空いてから次を起動する） */
async function waitUntilDown(base: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      await res.arrayBuffer().catch(() => {});
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name !== "TimeoutError" && name !== "AbortError") return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`サーバーが停止しませんでした（ポート ${PORT}）`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
    if (child.exitCode !== null || child.signalCode !== null) done();
  });
}

let serverProc: ChildProcess | null = null;

function spawnPreview(): ChildProcess {
  const proc = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, SEN_PERSIST_DIR: path.join(WORK_DIR, "state"), PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  // 出力を読まないとパイプが詰まり、プロセスが止まらなくなる
  proc.stdout?.on("data", (d) => process.env.DEBUG && process.stdout.write(d));
  proc.stderr?.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  proc.on("error", (err) => log(`サーバーの起動に失敗しました: ${err.message}`));
  return proc;
}

/** fresh のときだけ保存先を消す。起動し直すときはアカウントとデータを残す */
async function launchServer(fresh: boolean): Promise<void> {
  if (fresh) {
    await rm(path.join(WORK_DIR, "state"), { recursive: true, force: true });
    log(`ローカルサーバーを起動しています（ポート ${PORT}、まっさらな DB）…`);
  }
  serverProc = spawnPreview();
  await waitForServer(`http://localhost:${PORT}`);
}

async function stopServer(): Promise<void> {
  const current = serverProc;
  serverProc = null;
  if (!current) return;
  if (current.pid) {
    try {
      process.kill(-current.pid);
    } catch {
      try {
        current.kill();
      } catch {
        // すでに終了している
      }
    }
  } else {
    try {
      current.kill();
    } catch {
      // すでに終了している
    }
  }
  // 終了を待つ。終わらなければ強制終了し、そのあとポートが空くまで待つ
  await waitForExit(current, 5_000);
  if (current.exitCode === null && current.signalCode === null && current.pid) {
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch {
      try {
        current.kill("SIGKILL");
      } catch {
        // すでに終了している
      }
    }
    await waitForExit(current, 5_000);
  }
  await waitUntilDown(`http://localhost:${PORT}`, 20_000);
}

/** ビルドは最初の 1 回だけ。起動そのものは launchServer に分けて、あとから起動し直せる */
async function bootServer(): Promise<string> {
  if (urlArg) return urlArg.replace(/\/$/, "");
  if (!skipBuild) {
    log("アプリをビルドしています…");
    execSync("bunx vite build", { cwd: ROOT, stdio: "inherit" });
  }
  // 最初は連携なしで起動する。前回の収録が書き足した設定が残っていても外す
  await removeTutorialsBlock();
  await launchServer(true);
  return `http://localhost:${PORT}`;
}

function withoutTutorialsBlock(text: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!skipping && line === TUTORIALS_BEGIN) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line === TUTORIALS_END) skipping = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\s*$/, "");
}

async function readDevVars(): Promise<string | null> {
  try {
    return await readFile(DEV_VARS, "utf8");
  } catch {
    return null;
  }
}

/** マーカーで囲んだ連携の設定を取り除く。ファイルが無ければ何もしない */
async function removeTutorialsBlock(): Promise<void> {
  const current = await readDevVars();
  if (current === null || !current.includes(TUTORIALS_BEGIN)) return;
  const next = withoutTutorialsBlock(current);
  await writeFile(DEV_VARS, next ? `${next}\n` : "");
}

let serviceAccountKey: string | null = null;

/** 収録のたびに作り捨てる。鍵そのものはログに出さない */
function tutorialServiceAccountKey(): string {
  if (serviceAccountKey) return serviceAccountKey;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // JSON は 1 行になる（改行は \n として入る）
  serviceAccountKey = JSON.stringify({
    type: "service_account",
    client_email: "sen-tutorial@sen-tutorial.iam.gserviceaccount.com",
    private_key: privateKey,
  });
  return serviceAccountKey;
}

/**
 * dist/sen/.dev.vars の末尾に連携の設定を書く。vite preview はここを読む。
 * 同じマーカーのブロックが残っていても、先に消してから 1 つだけ書き足す。
 */
async function writeTutorialsBlock(ws: string): Promise<void> {
  const origin = googleMock.origin;
  if (!origin) throw new Error("模擬の Google が起動していません");
  const body = withoutTutorialsBlock((await readDevVars()) ?? "");
  const block = [
    TUTORIALS_BEGIN,
    // GOOGLE_API_ORIGIN_FOR_TESTS は DEV_TOOLS=1 のときだけ効く。.env に頼らず、このブロックだけで模擬の Google に向ける
    "DEV_TOOLS=1",
    `SHEETS_WORKSPACE=${ws}`,
    `SHEETS_SPREADSHEET_ID=${TUTORIAL_SPREADSHEET_ID}`,
    `SHEETS_SYNC_DELAY_MS=${TUTORIAL_SHEETS_DELAY_MS}`,
    `GOOGLE_API_ORIGIN_FOR_TESTS=${origin}`,
    `GOOGLE_SERVICE_ACCOUNT_KEY='${tutorialServiceAccountKey()}'`,
    TUTORIALS_END,
  ].join("\n");
  await mkdir(path.dirname(DEV_VARS), { recursive: true });
  await writeFile(DEV_VARS, body ? `${body}\n${block}\n` : `${block}\n`);
}

async function switchSheets(enable: boolean, ws: string): Promise<void> {
  if (enable) {
    // 初期化の操作で反映が予約されないよう、初期化のあとで連携を有効にする。
    // 動画を「まだ反映していません」から始めるため。
    googleMock.reset();
    await writeTutorialsBlock(ws);
    log("スプレッドシート連携を有効にしてサーバーを起動し直しています…");
  } else {
    await removeTutorialsBlock();
    log("スプレッドシート連携を無効にしてサーバーを起動し直しています…");
  }
  await stopServer();
  await launchServer(false);
}

async function reopenApi(current: APIRequestContext, base: string): Promise<APIRequestContext> {
  const state = await current.storageState();
  await current.dispose();
  return request.newContext({
    baseURL: base,
    extraHTTPHeaders: { "x-sen-client": "1" },
    storageState: state,
  });
}

async function prepareAccount(api: APIRequestContext): Promise<string> {
  // Google を通さない開発用のログイン（DEV_TOOLS=1 のときだけ使える）
  const res = await api.post("/api/auth/dev/sign-in", { data: { email: USER.email, name: USER.name } });
  if (!res.ok()) throw new Error(`ログインに失敗しました（DEV_TOOLS=1 が必要です）: ${res.status()} ${await res.text()}`);
  const me = (await (await api.get("/api/me")).json()) as { workspaces: { urlKey: string }[] };
  if (me.workspaces[0]) return me.workspaces[0].urlKey;
  const ws = await api.post("/api/workspaces", { data: { name: USER.workspaceName } });
  if (!ws.ok()) throw new Error(`ワークスペースを作れませんでした: ${ws.status()} ${await ws.text()}`);
  return ((await ws.json()) as { workspaceKey: string }).workspaceKey;
}

async function resetData(api: APIRequestContext, ws: string, freshUser: boolean) {
  const r = await api.post(`/api/dev/seed-demo?ws=${ws}`);
  if (!r.ok()) throw new Error(`デモデータの投入に失敗しました（DEV_TOOLS=1 が必要です）: ${r.status()}`);
  await api.post(`/api/mutate?ws=${ws}`, {
    data: {
      ops: [{ clientId: "tutorial", mutation: { type: "user.update", args: { name: USER.name, settings: { welcomeDismissed: !freshUser } } } }],
    },
  });
}

type LoadedScenario = Scenario & { file: string; needsSheets: boolean };

async function loadScenarios(): Promise<LoadedScenario[]> {
  const dir = path.join(ROOT, "tutorials", "scenarios");
  const files = (await readdir(dir)).filter((f) => /\.tsx?$/.test(f)).sort();
  const list: LoadedScenario[] = [];
  for (const f of files) {
    // export const sheets = true のシナリオは、スプレッドシート連携を有効にして撮る
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as { default: Scenario; sheets?: boolean };
    list.push({ ...mod.default, file: path.join(dir, f), needsSheets: mod.sheets === true });
  }
  return list.sort((a, b) => a.order - b.order);
}

interface ManifestEntry {
  id: string;
  title: string;
  summary: string;
  screen: string;
  order: number;
  duration: number;
  video: string;
  poster: string;
  chapters: { t: number; title: string }[];
  recordedAt: string;
  /** 収録したときの画面・シナリオのハッシュ（bun run tutorials:check で古い動画を見つける） */
  sourceHash?: string;
  /** 読み上げを付けたか（cue が 1 つでもあれば true） */
  narration: boolean;
}

/**
 * タイトルと字幕を先に読み上げておく。ビルドやサーバー起動と並行して進める。
 * 起動が先に失敗したときは、読み上げの失敗を未処理の拒否にしない。
 */
function startNarrationPrefetch(narrator: Narrator, scenarios: LoadedScenario[]): Promise<void> {
  log(`ナレーション: ${narrator.describe()}`);
  const pending = (async () => {
    const texts: string[] = [];
    for (const s of scenarios) {
      texts.push(titleNarration(s.title, s.summary));
      texts.push(...collectNarrationTexts(await readFile(s.file, "utf8")));
    }
    await narrator.prefetch(texts, (done, total) => {
      log(`ナレーションを準備しています（${done}/${total}）`);
    });
  })();
  void pending.catch(() => {});
  return pending;
}

async function main() {
  const narrator = noNarration ? null : Narrator.fromEnv(path.join(WORK_DIR, "_narration"));
  if (!noNarration && !narrator) {
    console.error("GEMINI_API_KEY が設定されていません。ナレーションなしで撮るときは --no-narration を付けてください");
    process.exit(1);
  }

  let scenarios = (await loadScenarios()).filter((s) => !filters.length || filters.some((f) => s.id.includes(f)));
  if (!scenarios.length) throw new Error("該当するシナリオがありません");
  const failures: string[] = [];
  // --url では模擬の Google を使えない。初期化より前に外し、既存の課題などを消さない。
  if (urlArg) {
    const kept: LoadedScenario[] = [];
    for (const s of scenarios) {
      if (!s.needsSheets) {
        kept.push(s);
        continue;
      }
      const message = `${s.id}: スプレッドシート連携の動画は、ローカルで収録してください（--url では模擬の Google を使えません）`;
      failures.push(message);
      console.error(message);
    }
    scenarios = kept;
    if (!scenarios.length) {
      console.error(`\n収録に失敗したシナリオ:\n- ${failures.join("\n- ")}`);
      process.exit(1);
    }
  }
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  // 読み上げはビルドと起動のあいだに進める。最初の収録の前に待つ。
  const narrationReady = narrator ? startNarrationPrefetch(narrator, scenarios) : Promise.resolve();

  let api: APIRequestContext | undefined;
  let browser: Browser | undefined;
  try {
    if (!urlArg && scenarios.some((s) => s.needsSheets)) {
      const origin = await googleMock.start(GOOGLE_PORT);
      log(`模擬の Google を起動しました（${origin}）`);
    }
    const base = await bootServer();
    api = await request.newContext({ baseURL: base, extraHTTPHeaders: { "x-sen-client": "1" } });
    const ws = await prepareAccount(api);
    log(`ワークスペース: ${ws}`);
    const storage = await api.storageState();

    const manifestPath = path.join(OUT_DIR, "manifest.json");
    const manifest: { tutorials: ManifestEntry[] } = existsSync(manifestPath)
      ? JSON.parse(await readFile(manifestPath, "utf8"))
      : { tutorials: [] };

    browser = await chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text"] });
    await narrationReady;
    // 最初のサーバーは連携なし。シナリオごとに、必要な状態と違えば起動し直す
    let sheetsOn = false;
    for (const s of scenarios) {
      log(`収録中: ${s.order}. ${s.title}`);
      if (!api) throw new Error("API の準備ができていません");
      await resetData(api, ws, !!s.freshUser);
      if (!urlArg && s.needsSheets !== sheetsOn) {
        await switchSheets(s.needsSheets, ws);
        sheetsOn = s.needsSheets;
        api = await reopenApi(api, base);
      }
      const context = await browser.newContext({
        baseURL: base,
        viewport: VIEWPORT,
        deviceScaleFactor: SCALE,
        colorScheme: "dark",
        locale: "ja-JP",
        timezoneId: "Asia/Tokyo",
        storageState: storage,
      });
      // Mac として振る舞わせ、ショートカットの表示を ⌘ にそろえる。テーマはダーク固定。
      // （tsx/esbuild が関数名保持のために挿入する __name をブラウザ側で無害化してから実行する）
      await context.addInitScript({
        content: [
          "var __name = (f) => f;",
          "Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true });",
          // 収録中はトーストを字幕より上に出して重ならないようにする
          "document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.toasts{bottom:150px!important}.selection-bar{bottom:118px!important}'; document.head.appendChild(st); });",
          "try { localStorage.setItem('sen:theme', 'dark'); localStorage.setItem('sen:theme-v', JSON.stringify('dark')); localStorage.setItem('sen:recording', '1'); } catch (e) {}",
          `(${overlayScript.toString()})(${JSON.stringify({ accent: ACCENT })});`,
        ].join("\n"),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/${ws}${s.start}`);
      await page.waitForSelector("[data-testid=app]", { timeout: 30_000 });
      await page.waitForTimeout(1200);
      const platform = await page.evaluate(() => navigator.platform);
      if (platform !== "MacIntel") log(`  ⚠ platform の上書きに失敗しました: ${platform}`);
      // カーソルは一覧の行に重ならない位置から始める（ホバーでフォーカスが動かないように）
      await page.mouse.move(PARK.x, PARK.y);

      const recorder = new ScreenRecorder(page, path.join(WORK_DIR, s.id));
      const t = new Director(page, ws, recorder, { speed, narrator });
      t.setMouse(PARK.x, PARK.y);
      t.posterFile = path.join(OUT_DIR, `${s.id}.jpg`);
      await recorder.start();
      try {
        await t.title(`レッスン ${s.order}`, s.title, s.summary);
        await s.run(t);
        await t.finish();
        await t.hideCaption();
        await t.wait(700);
      } catch (e) {
        failures.push(`${s.id}: ${(e as Error).message}`);
        console.error(e);
        await page.screenshot({ path: path.join(WORK_DIR, `${s.id}-error.png`) });
      }
      await recorder.stop();
      if (failures.some((f) => f.startsWith(`${s.id}:`))) {
        await context.close();
        continue;
      }
      const video = `${s.id}.mp4`;
      const poster = `${s.id}.jpg`;
      // サムネイルはシナリオが t.poster() で撮ったもの（字幕なし）。撮っていなければ動画から切り出す
      const videoPath = path.join(OUT_DIR, video);
      const duration = await recorder.encode(videoPath, t.posterTaken ? null : path.join(OUT_DIR, poster), {
        width: VIDEO_WIDTH,
        posterAt: Math.min(5.5, t.chapters[0]?.t ? t.chapters[0].t + 2 : 4),
      });
      if (t.narrationCues.length) {
        await muxNarration({ video: videoPath, cues: t.narrationCues, duration, workDir: recorder.workDirPath });
      }
      if (t.posterTaken) {
        const full = `${path.join(OUT_DIR, poster)}.full.jpg`;
        spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", full, "-vf", "scale=960:-2", "-q:v", "4", path.join(OUT_DIR, poster)]);
        await rm(full, { force: true });
      }
      if (!keepFrames) await recorder.cleanup();
      if (errors.length) log(`  ⚠ ページでエラー: ${errors.slice(0, 3).join(" / ")}`);
      const entry: ManifestEntry = {
        id: s.id,
        title: s.title,
        summary: s.summary,
        screen: s.screen,
        order: s.order,
        duration: Math.round(duration * 10) / 10,
        video: `/tutorials/${video}`,
        poster: `/tutorials/${poster}`,
        chapters: t.chapters.map((c) => ({ t: Math.round(c.t * 10) / 10, title: c.title })),
        recordedAt: new Date().toISOString(),
        sourceHash: await sourceHash(ROOT, s.file),
        narration: t.narrationCues.length > 0,
      };
      manifest.tutorials = [...manifest.tutorials.filter((x) => x.id !== s.id), entry].sort((a, b) => a.order - b.order);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      log(`  ✓ ${video}（${entry.duration}秒・${entry.chapters.length}ステップ・${entry.narration ? "ナレーションあり" : "ナレーションなし"}）`);
      await context.close();
    }
  } finally {
    await browser?.close().catch(() => {});
    await api?.dispose().catch(() => {});
    try {
      await stopServer();
    } finally {
      try {
        await googleMock.stop();
      } finally {
        // サーバーを止めたあと、模擬サーバー向けの設定を dist/ に残さない
        await removeTutorialsBlock();
      }
    }
  }
  if (failures.length) {
    console.error(`\n収録に失敗したシナリオ:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  log(`完了: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
