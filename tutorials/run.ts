/**
 * 操作説明動画の自動収録
 *
 *   bun run tutorials                 # すべて収録
 *   bun run tutorials -- create board # id の一部で絞り込み
 *   bun run tutorials -- --skip-build # ビルドを省略
 *   bun run tutorials -- --url https://xxx.workers.dev  # 既存の環境で収録（DEV_TOOLS=1 が必要）
 *
 * 流れ: アプリをビルド → まっさらな DB でローカル起動 → デモデータを投入 →
 *       ヘッドレス Chromium で各シナリオを AI（スクリプト）が操作 → CDP で録画 → ffmpeg で MP4 化 →
 *       public/tutorials/ に動画・サムネイル・manifest.json を書き出す
 */
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, request, type APIRequestContext } from "playwright";
import { overlayScript } from "./lib/overlay";
import { ScreenRecorder } from "./lib/recorder";
import { Director, PARK } from "./lib/director";
import type { Scenario } from "./lib/types";
import { sourceHash } from "./lib/source-hash";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "tutorials");
const WORK_DIR = path.join(os.tmpdir(), "sen-tutorials");
const PORT = Number(process.env.TUTORIAL_PORT ?? 4319);
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 1.5;
const VIDEO_WIDTH = 1600;
const ACCENT = "#6470e8";
const USER = { name: "山田 太郎", email: "taro@example.com", workspaceName: "ミライ株式会社" };

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const keepFrames = args.includes("--keep-frames");
const urlArg = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
const filters = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--url");

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

async function startServer(): Promise<{ base: string; proc: ChildProcess | null }> {
  if (urlArg) return { base: urlArg.replace(/\/$/, ""), proc: null };
  if (!skipBuild) {
    log("アプリをビルドしています…");
    execSync("bunx vite build", { cwd: ROOT, stdio: "inherit" });
  }
  const persist = path.join(WORK_DIR, "state");
  await rm(persist, { recursive: true, force: true });
  log(`ローカルサーバーを起動しています（ポート ${PORT}、まっさらな DB）…`);
  const proc = spawn("bunx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, SEN_PERSIST_DIR: persist, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  proc.stderr?.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
  const base = `http://localhost:${PORT}`;
  await waitForServer(base);
  return { base, proc };
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

async function loadScenarios(): Promise<(Scenario & { file: string })[]> {
  const dir = path.join(ROOT, "tutorials", "scenarios");
  const files = (await readdir(dir)).filter((f) => /\.tsx?$/.test(f)).sort();
  const list: (Scenario & { file: string })[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as { default: Scenario };
    list.push({ ...mod.default, file: path.join(dir, f) });
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
}

async function main() {
  const scenarios = (await loadScenarios()).filter((s) => !filters.length || filters.some((f) => s.id.includes(f)));
  if (!scenarios.length) throw new Error("該当するシナリオがありません");
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(WORK_DIR, { recursive: true });
  const { base, proc } = await startServer();
  const api = await request.newContext({ baseURL: base, extraHTTPHeaders: { "x-sen-client": "1" } });
  const ws = await prepareAccount(api);
  log(`ワークスペース: ${ws}`);
  const storage = await api.storageState();

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  const manifest: { tutorials: ManifestEntry[] } = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : { tutorials: [] };

  const browser = await chromium.launch({ args: ["--font-render-hinting=none", "--disable-lcd-text"] });
  const failures: string[] = [];
  try {
    for (const s of scenarios) {
      log(`収録中: ${s.order}. ${s.title}`);
      await resetData(api, ws, !!s.freshUser);
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
      const t = new Director(page, ws, recorder);
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
      const duration = await recorder.encode(path.join(OUT_DIR, video), t.posterTaken ? null : path.join(OUT_DIR, poster), {
        width: VIDEO_WIDTH,
        posterAt: Math.min(5.5, t.chapters[0]?.t ? t.chapters[0].t + 2 : 4),
      });
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
      };
      manifest.tutorials = [...manifest.tutorials.filter((x) => x.id !== s.id), entry].sort((a, b) => a.order - b.order);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      log(`  ✓ ${video}（${entry.duration}秒・${entry.chapters.length}ステップ）`);
      await context.close();
    }
  } finally {
    await browser.close();
    await api.dispose();
    if (proc?.pid) {
      try {
        process.kill(-proc.pid);
      } catch {
        proc.kill();
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
