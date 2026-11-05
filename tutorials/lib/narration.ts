import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// 字幕とタイトルカードを Gemini TTS で読み上げ、24kHz モノラルの PCM にする。
// API キーはログにもエラーにもファイルにも出さない。

const DEFAULT_MODEL = "gemini-3.8-flash-tts";
const DEFAULT_VOICE = "Kore";
const DEFAULT_STYLE = [
  "Read the following Japanese narration aloud for a software tutorial video. Use a calm, warm and clear voice at a relaxed, slightly slow pace. Read only the transcript.",
  "",
  "TRANSCRIPT:",
].join("\n");
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_CONCURRENCY = 3;
const SAMPLE_RATE = 24000;
/** s16le・モノラルなので、1 秒は 48000 バイト */
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const MAX_ATTEMPTS = 6;
const BACKOFF_SEC = [2, 4, 8, 16, 32];
const REQUEST_TIMEOUT_MS = 90_000;
const SILENCE_FILTER =
  "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB,areverse";

export interface NarrationClip {
  /** 24kHz / モノラル / s16le の .pcm */
  file: string;
  /** 秒 */
  duration: number;
}

export interface NarratorOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  style?: string;
  cacheDir: string;
  concurrency?: number;
  baseUrl?: string;
}

/** 再試行しても直らないエラー（キーやモデル名の誤りなど） */
class FatalNarrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalNarrationError";
  }
}

/**
 * 字幕の記号を、TTS が読み間違えない言い方に置き換える。
 * 置き換えの順序に意味がある（括弧の中の Ctrl や + を、先に別の言葉へ変えない）。
 */
export function toSpeech(text: string): string {
  let speech = text;

  // （Ctrl…）は「、または Ctrl…」。中身の Ctrl や + は、このあとの規則で読む。
  speech = speech.replace(/（(Ctrl[^）]*)）/g, "、または $1");

  // キーの間の +（前後の空白ごと）
  speech = speech.replace(/\s*\+\s*/g, " プラス ");

  speech = speech.replaceAll("⌘", "コマンド ");
  speech = speech.replace(/\bCtrl\b/g, "コントロール");
  speech = speech.replaceAll("⇧", "シフト");
  speech = speech.replaceAll("⌥", "オプション");

  // 「G → I」のような、空白で区切られた矢印は操作の順序
  speech = speech.replace(/\s+→\s+/g, " のあとに ");
  // 「J / K」のように英字 1 文字どうし
  speech = speech.replace(/(?<![A-Za-z])([A-Za-z]) \/ ([A-Za-z])(?![A-Za-z])/g, "$1 と $2");
  // 先頭、または空白のあとの「/ キー」
  speech = speech.replace(/(^|\s)\/ キー/g, "$1スラッシュキー");

  speech = speech.replaceAll("↓", "下矢印キー");
  speech = speech.replaceAll("↑", "上矢印キー");
  speech = speech.replaceAll("←", "左矢印キー");
  // 前後に空白が無い → は矢印キー。空白付きは上で「のあとに」済み
  speech = speech.replaceAll("→", "右矢印キー");

  speech = speech.replaceAll("★", "星のマーク");
  speech = speech.replaceAll("×", "バツ");
  speech = speech.replaceAll("@", "アットマーク");
  speech = speech.replace(/(^|\s)\?(?=\s|$)/g, "$1はてなキー");

  speech = speech.replace(/\bEsc\b/g, "エスケープ");
  speech = speech.replace(/\bSen\b/g, "セン");

  speech = speech.replaceAll("##", "シャープ 2 つ");
  speech = speech.replace(/(^|、)\s*-\s*で/g, "$1ハイフンで");

  // 「1 = 緊急」の = は「は」。空白ごと置き換えて「1 は緊急」にする
  speech = speech.replace(/ = /g, " は");

  return speech.replace(/\s+/g, " ").trim();
}

/** タイトルカードの読み上げ。「。」が重ならないように結ぶ */
export function titleNarration(title: string, summary: string): string {
  const head = title.endsWith("。") ? title : `${title}。`;
  return `${head}${summary}`;
}

/**
 * シナリオのソースから、先読みしたい字幕を集める。
 * caption("…") の第 1 引数。同じ呼び出しに say: "…" があれば、そちらを使う。
 * 取りこぼしても、収録のときに取りに行く。
 */
export function collectNarrationTexts(source: string): string[] {
  const texts: string[] = [];
  const re = /\bcaption\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    let i = skipWs(source, match.index + match[0].length);
    const first = readDoubleQuoted(source, i);
    if (!first) continue;
    i = skipWs(source, first.end);
    let speech = first.value;
    if (source[i] === ",") {
      i = skipWs(source, i + 1);
      if (source[i] === "{") {
        const say = readSay(source, i);
        if (say != null) speech = say;
      }
    }
    texts.push(speech);
  }
  return texts;
}

export class Narrator {
  /** ログ・JSON 化でもキーが出ないよう、言語のプライベートフィールドにする */
  readonly #apiKey: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly style: string;
  private readonly cacheDir: string;
  private readonly concurrency: number;
  private readonly baseUrl: string;
  /** 同じ文への同時リクエストは、1 つの Promise にまとめる */
  private readonly inflight = new Map<string, Promise<NarrationClip>>();

  constructor(opts: NarratorOptions) {
    if (!opts.apiKey) throw new Error("音声合成の API キーが空です");
    if (!opts.cacheDir) throw new Error("ナレーションのキャッシュディレクトリが指定されていません");
    this.#apiKey = opts.apiKey;
    this.model = opts.model?.trim() || DEFAULT_MODEL;
    this.voice = opts.voice?.trim() || DEFAULT_VOICE;
    this.style = opts.style?.trim() ? opts.style : DEFAULT_STYLE;
    this.cacheDir = opts.cacheDir;
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.concurrency = normalizeConcurrency(opts.concurrency);
  }

  /** 環境変数から作る。GEMINI_API_KEY が無ければ null（キーの値はどこにも出さない） */
  static fromEnv(cacheDir: string): Narrator | null {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    return new Narrator({
      apiKey,
      model: process.env.GEMINI_TTS_MODEL,
      voice: process.env.GEMINI_TTS_VOICE,
      style: process.env.GEMINI_TTS_STYLE,
      cacheDir,
      concurrency: process.env.GEMINI_TTS_CONCURRENCY ? Number(process.env.GEMINI_TTS_CONCURRENCY) : undefined,
      baseUrl: process.env.GEMINI_API_BASE_URL,
    });
  }

  /** toSpeech した文の PCM が、すでにキャッシュにあるか */
  has(text: string): boolean {
    try {
      return statSync(this.cachePath(toSpeech(text))).isFile();
    } catch {
      return false;
    }
  }

  /** toSpeech してから、キャッシュにあればそれを、無ければ API から取得する */
  clip(text: string): Promise<NarrationClip> {
    return this.load(toSpeech(text));
  }

  /**
   * 重複を除いて、concurrency 本ずつ先に取得する。
   * 1 つでも失敗したら、そのエラーで終わる。
   */
  async prefetch(texts: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
      const speech = toSpeech(text);
      if (!speech || seen.has(speech)) continue;
      seen.add(speech);
      unique.push(speech);
    }
    const total = unique.length;
    if (total === 0) return;

    let done = 0;
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed) {
        const index = next++;
        if (index >= total) return;
        try {
          await this.load(unique[index]);
        } catch (err) {
          failed = true;
          throw err;
        }
        done++;
        onProgress?.(done, total);
      }
    };
    const workers = Math.min(this.concurrency, total);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  /** ログ用。モデルと声だけ（API キーは含めない） */
  describe(): string {
    return `${this.model} / ${this.voice}`;
  }

  private cachePath(speech: string): string {
    const key = createHash("sha256")
      .update(JSON.stringify({ v: 1, model: this.model, voice: this.voice, style: this.style, speech }))
      .digest("hex");
    return path.join(this.cacheDir, `${key}.pcm`);
  }

  private load(speech: string): Promise<NarrationClip> {
    const file = this.cachePath(speech);
    const existing = this.inflight.get(file);
    if (existing) return existing;
    const pending = this.produce(speech, file).finally(() => {
      this.inflight.delete(file);
    });
    this.inflight.set(file, pending);
    return pending;
  }

  private async produce(speech: string, file: string): Promise<NarrationClip> {
    const cached = await readCached(file);
    if (cached) return cached;

    await mkdir(this.cacheDir, { recursive: true });
    const pcm = await this.synthesize(speech);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, pcm);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { file, duration: pcm.length / BYTES_PER_SECOND };
  }

  /** API から音声を受け取り、無音を削った 24kHz モノラル s16le にする */
  private async synthesize(speech: string): Promise<Buffer> {
    const audio = await this.fetchAudio(speech);
    const id = randomBytes(8).toString("hex");
    const src = path.join(this.cacheDir, `${id}${audio.ext}`);
    const out = path.join(this.cacheDir, `${id}.out.pcm`);
    await writeFile(src, audio.bytes);
    try {
      const args = ["-y", "-loglevel", "error"];
      if (audio.kind === "pcm") args.push("-f", "s16le", "-ar", String(audio.rate), "-ac", "1");
      args.push("-i", src, "-af", SILENCE_FILTER, "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", out);
      await run("ffmpeg", args);
      return await readFile(out);
    } finally {
      await rm(src, { force: true });
      await rm(out, { force: true });
    }
  }

  private async fetchAudio(speech: string): Promise<{ bytes: Buffer; kind: "wav" | "pcm" | "auto"; rate: number; ext: string }> {
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: `${this.style}\n${speech}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      },
    });

    let lastError = "音声の生成に失敗しました";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.#apiKey,
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const parsed = await readBody(res);

        if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
          throw new FatalNarrationError(httpError(res.status, parsed, this.model, this.#apiKey));
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = httpError(res.status, parsed, this.model, this.#apiKey);
          if (attempt === MAX_ATTEMPTS - 1) break;
          const delay = res.status === 429 ? retryDelayMs(parsed, attempt) : backoffMs(attempt);
          await sleep(delay);
          continue;
        }
        if (!res.ok) {
          throw new FatalNarrationError(httpError(res.status, parsed, this.model, this.#apiKey));
        }

        const inline = extractInlineAudio(parsed);
        if (!inline) {
          lastError = "応答に音声データがありませんでした";
          if (attempt === MAX_ATTEMPTS - 1) break;
          await sleep(backoffMs(attempt));
          continue;
        }
        return classifyAudio(inline.mimeType, inline.data);
      } catch (err) {
        if (err instanceof FatalNarrationError) throw err;
        lastError = `音声の生成に失敗しました: ${sanitize(causeMessage(err), this.#apiKey)}`;
        if (attempt === MAX_ATTEMPTS - 1) break;
        await sleep(backoffMs(attempt));
      }
    }
    throw new Error(lastError);
  }
}

/**
 * 映像はそのまま、ナレーションを足した MP4 に置き換える。
 * 各 cue の PCM は、時刻 t の位置へ加算する（重なったところは ±32767 でクリップ）。
 */
export async function muxNarration(opts: {
  video: string;
  cues: { t: number; clip: NarrationClip }[];
  duration: number;
  workDir: string;
}): Promise<void> {
  const total = Math.max(0, Math.round(opts.duration * SAMPLE_RATE));
  const mixed = Buffer.alloc(total * 2);
  for (const cue of opts.cues) {
    const pcm = await readFile(cue.clip.file);
    const start = Math.round(cue.t * SAMPLE_RATE);
    const count = Math.floor(pcm.length / 2);
    const from = Math.max(0, -start);
    const to = Math.min(count, total - start);
    for (let i = from; i < to; i++) {
      const at = start + i;
      const offset = at * 2;
      const sum = mixed.readInt16LE(offset) + pcm.readInt16LE(i * 2);
      const clipped = Math.max(-32767, Math.min(32767, sum));
      mixed.writeInt16LE(clipped, offset);
    }
  }

  await mkdir(opts.workDir, { recursive: true });
  const narration = path.join(opts.workDir, "narration.pcm");
  await writeFile(narration, mixed);

  const tmpVideo = `${opts.video}.tmp.mp4`;
  try {
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      opts.video,
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-i",
      narration,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      tmpVideo,
    ]);
  } catch (err) {
    await rm(tmpVideo, { force: true });
    throw err;
  }
  await rename(tmpVideo, opts.video);
}

function normalizeConcurrency(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 1) return DEFAULT_CONCURRENCY;
  return Math.floor(value);
}

async function readCached(file: string): Promise<NarrationClip | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { file, duration: info.size / BYTES_PER_SECOND };
  } catch {
    return null;
  }
}

function httpError(status: number, body: unknown, model: string, apiKey: string): string {
  return sanitize(`音声の生成に失敗しました（HTTP ${status}、モデル ${model}）: ${errorMessage(body)}`, apiKey);
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "サーバーからの説明はありませんでした";
}

function retryDelayMs(body: unknown, attempt: number): number {
  const details =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { details?: unknown } }).error?.details
      : undefined;
  if (Array.isArray(details)) {
    for (const item of details) {
      if (!item || typeof item !== "object" || !("retryDelay" in item)) continue;
      const delay = (item as { retryDelay?: unknown }).retryDelay;
      if (typeof delay !== "string") continue;
      const match = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
      if (match) return Math.round(Number(match[1]) * 1000);
    }
  }
  return backoffMs(attempt);
}

function backoffMs(attempt: number): number {
  const sec = BACKOFF_SEC[Math.min(attempt, BACKOFF_SEC.length - 1)];
  return sec * 1000;
}

function causeMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "タイムアウトしました";
    if (err.message) return err.message;
  }
  return "通信に失敗しました";
}

/** 万一メッセージにキーが混ざっても、外に出さない */
function sanitize(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("(api key)");
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractInlineAudio(body: unknown): { mimeType: string; data: string } | null {
  if (!body || typeof body !== "object" || !("candidates" in body)) return null;
  const candidates = (body as { candidates?: unknown }).candidates;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!first || typeof first !== "object" || !("content" in first)) return null;
  const content = (first as { content?: unknown }).content;
  if (!content || typeof content !== "object" || !("parts" in content)) return null;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("inlineData" in part)) continue;
    const inline = (part as { inlineData?: unknown }).inlineData;
    if (!inline || typeof inline !== "object" || !("data" in inline)) continue;
    const data = (inline as { data?: unknown }).data;
    const mimeType = "mimeType" in inline ? (inline as { mimeType?: unknown }).mimeType : undefined;
    if (typeof data === "string" && data.length > 0) {
      return { mimeType: typeof mimeType === "string" ? mimeType : "", data };
    }
  }
  return null;
}

function classifyAudio(mimeType: string, data: string): { bytes: Buffer; kind: "wav" | "pcm" | "auto"; rate: number; ext: string } {
  const bytes = Buffer.from(data, "base64");
  const mime = mimeType.toLowerCase();
  const isRiff = bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "RIFF";
  if (mime.includes("wav") || isRiff) return { bytes, kind: "wav", rate: SAMPLE_RATE, ext: ".wav" };
  if (mime.includes("audio/l16") || mime.includes("audio/pcm")) {
    const rateMatch = /rate=(\d+)/i.exec(mimeType);
    const parsed = rateMatch ? Number(rateMatch[1]) : SAMPLE_RATE;
    const rate = Number.isFinite(parsed) && parsed > 0 ? parsed : SAMPLE_RATE;
    return { bytes, kind: "pcm", rate, ext: ".raw" };
  }
  return { bytes, kind: "auto", rate: SAMPLE_RATE, ext: ".bin" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.on("error", () => fail(new Error(`${cmd} を起動できませんでした`)));
    child.on("exit", (code) => {
      if (code === 0) {
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      fail(new Error(`${cmd} が終了コード ${code ?? "不明"} で失敗しました`));
    });
  });
}

function skipWs(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function readDoubleQuoted(source: string, i: number): { value: string; end: number } | null {
  if (source[i] !== '"') return null;
  let value = "";
  i++;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) return null;
      if (next === "u" && /^[0-9a-fA-F]{4}/.test(source.slice(i + 2, i + 6))) {
        value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
      value += simple[next] ?? next;
      i += 2;
      continue;
    }
    if (c === '"') return { value, end: i + 1 };
    value += c;
    i++;
  }
  return null;
}

function skipLiteral(source: string, i: number): number {
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return i + 1;
  i++;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return i;
}

/** 第 2 引数のオブジェクトから say: "…" を探す。無ければ null */
function readSay(source: string, openBrace: number): string | null {
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipLiteral(source, i) - 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const body = source.slice(openBrace, i + 1);
        const found = /\bsay\s*:\s*"/.exec(body);
        if (!found) return null;
        return readDoubleQuoted(body, found.index + found[0].length - 1)?.value ?? null;
      }
    }
  }
  return null;
}
