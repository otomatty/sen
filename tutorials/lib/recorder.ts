import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { CDPSession, Page } from "playwright";

// Chrome DevTools Protocol のスクリーンキャストで画面を記録し、ffmpeg で H.264 の MP4 にする。
// Playwright 標準の録画より文字がくっきりし、ファイルも小さい。

interface Frame {
  file: string;
  ts: number; // 秒（壁時計）
}

export class ScreenRecorder {
  private cdp: CDPSession | null = null;
  private frames: Frame[] = [];
  private writes: Promise<unknown>[] = [];
  private startedAt = 0;
  private stoppedAt = 0;
  private n = 0;
  /** 動画から除く区間（壁時計の秒）。ナレーションの待ち時間など */
  private pauses: { start: number; end: number }[] = [];
  /** 止めている最中なら、止め始めた壁時計の秒。そうでなければ null */
  private pausedAt: number | null = null;

  constructor(
    private page: Page,
    private workDir: string,
  ) {}

  /** ナレーションの合成に渡す作業ディレクトリ */
  get workDirPath(): string {
    return this.workDir;
  }

  async start() {
    await rm(this.workDir, { recursive: true, force: true });
    await mkdir(this.workDir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const ts = f.metadata.timestamp ?? Date.now() / 1000;
      const file = path.join(this.workDir, `f${String(this.n++).padStart(6, "0")}.jpg`);
      this.frames.push({ file, ts });
      this.writes.push(writeFile(file, Buffer.from(f.data, "base64")));
      this.cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
    this.startedAt = Date.now() / 1000;
  }

  /**
   * 収録を一時停止する。この間の時間は動画に入れない。
   * すでに止まっていれば何もしない。
   */
  pause() {
    if (this.pausedAt != null) return;
    this.pausedAt = Date.now() / 1000;
  }

  /** 一時停止を終える。止まっていなければ何もしない */
  resume() {
    if (this.pausedAt == null) return;
    this.pauses.push({ start: this.pausedAt, end: Date.now() / 1000 });
    this.pausedAt = null;
  }

  /** 収録開始からの経過秒（停止していた時間を除いた、動画上の時刻） */
  elapsed(): number {
    return this.toVideoTime(Date.now() / 1000);
  }

  /**
   * 壁時計の時刻（Unix 秒）を、動画の先頭からの秒に直す。
   * 開始からその時刻までに重なる停止区間を引き、止めている最中の区間も入れる。
   */
  private toVideoTime(wall: number): number {
    let paused = 0;
    const ranges = this.pausedAt == null ? this.pauses : [...this.pauses, { start: this.pausedAt, end: wall }];
    for (const range of ranges) {
      const from = Math.max(range.start, this.startedAt);
      const to = Math.min(range.end, wall);
      if (to > from) paused += to - from;
    }
    return Math.max(0, wall - this.startedAt - paused);
  }

  async stop() {
    // 止めたまま終わっても、その区間を動画から外す
    this.resume();
    this.stoppedAt = Date.now() / 1000;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    await Promise.all(this.writes);
    await this.cdp?.detach().catch(() => {});
  }

  /** フレーム列を可変フレームレートのまま並べ、30fps の MP4 に変換する */
  async encode(out: string, poster: string | null, opts: { width: number; posterAt?: number }) {
    // 動画の 0 秒 = start() を呼んだ瞬間。一時停止の区間は除くので、字幕の時刻と一致する。
    const start = this.startedAt;
    let frames = this.frames;
    const before = frames.filter((f) => f.ts <= start);
    frames = [...before.slice(-1), ...frames.filter((f) => f.ts > start)];
    if (!frames.length) throw new Error("フレームが記録されていません");
    const lines: string[] = [];
    const videoEnd = this.toVideoTime(this.stoppedAt);
    for (let i = 0; i < frames.length; i++) {
      const cur = frames[i];
      const begin = i === 0 ? 0 : this.toVideoTime(Math.max(cur.ts, start));
      const end = this.toVideoTime(i + 1 < frames.length ? frames[i + 1].ts : this.stoppedAt);
      if (end <= begin) continue;
      lines.push(`file '${cur.file}'`, `duration ${(end - begin).toFixed(4)}`);
    }
    // concat demuxer の仕様で、最後のファイルはもう一度書く
    lines.push(`file '${frames[frames.length - 1].file}'`);
    const listFile = path.join(this.workDir, "list.txt");
    await writeFile(listFile, lines.join("\n"));
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      `fps=30,scale=${opts.width}:-2:flags=lanczos,format=yuv420p`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-tune",
      "stillimage",
      "-movflags",
      "+faststart",
      out,
    ]);
    const at = opts.posterAt ?? Math.min(4, videoEnd / 2);
    if (poster) await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", out, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "4", poster]);
    return videoEnd;
  }

  async cleanup() {
    await rm(this.workDir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} が終了コード ${code} で失敗しました`))));
  });
}
