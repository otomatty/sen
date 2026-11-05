import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// 字幕とタイトルカードを Gemini TTS で読み上げ、24kHz モノラルの PCM にする。
// 1 本の台本はまとめて 1 リクエストで読み、無音の位置で文ごとに切り分ける。
// API キーはログにもエラーにもファイルにも出さない。

const DEFAULT_MODEL = "gemini-3.8-flash-tts";
const DEFAULT_VOICE = "Kore";
const DEFAULT_STYLE =
  "Calm, warm and clear narration for a software tutorial video, at a relaxed, slightly slow pace.";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TEMPO = 1.2;
const SAMPLE_RATE = 24000;
/** s16le・モノラルなので、1 秒は 48000 バイト */
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** 切り分けに使う 10ms 区間（240 サンプル） */
const FRAME_SAMPLES = 240;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const MAX_ATTEMPTS = 6;
const BACKOFF_SEC = [2, 4, 8, 16, 32];
const REQUEST_TIMEOUT_MS = 90_000;
/** これより長い 429 の待ちは、1 日の上限とみなして待たない */
const DAILY_QUOTA_WAIT_MS = 120_000;
const MAX_SCRIPT_LINES = 8;
const SCRIPT_STYLE =
  "Read the paragraphs in order, exactly as written. Leave a long, clear pause of about two seconds between paragraphs.";
const NO_AUDIO_MESSAGE = "応答に音声データがありませんでした";
const SILENCE_FILTER =
  "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB,areverse";

type FetchedAudio = { bytes: Buffer; kind: "wav" | "pcm" | "auto"; rate: number; ext: string };

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
  /** 読み上げの速さ。1 で等倍。未指定は 1.2 */
  tempo?: number;
  /** 台本をまとめて読む。未指定は true */
  batch?: boolean;
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
  private readonly tempo: number;
  private readonly batch: boolean;
  /** API へ送った HTTP リクエストの回数（再試行も 1 回ずつ数える） */
  private requests = 0;
  /** 同じ最終ファイルへの同時処理は、1 つの Promise にまとめる */
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
    this.tempo = normalizeTempo(opts.tempo);
    this.batch = opts.batch ?? true;
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
      tempo: process.env.GEMINI_TTS_TEMPO ? Number(process.env.GEMINI_TTS_TEMPO) : undefined,
      batch: parseBatch(process.env.GEMINI_TTS_BATCH),
    });
  }

  /** 速めたあとの PCM が、すでにキャッシュにあるか（倍率が 1 のときは合成したファイル） */
  has(text: string): boolean {
    try {
      return statSync(this.outputPath(toSpeech(text))).isFile();
    } catch {
      return false;
    }
  }

  /** API へ送った HTTP リクエストの回数 */
  get requestCount(): number {
    return this.requests;
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

  /**
   * 動画ごとの台本を先に読み上げる。
   * batch が無効なら、文を並べて prefetch と同じに読む。
   * 有効なら、最大 8 文ずつ 1 リクエストにまとめ、無音で切り分けてキャッシュする。
   */
  async prefetchScripts(
    scripts: string[][],
    opts?: { onProgress?: (done: number, total: number) => void; onLog?: (message: string) => void },
  ): Promise<void> {
    if (!this.batch) {
      await this.prefetch(scripts.flat(), opts?.onProgress);
      return;
    }

    const seen = new Set<string>();
    const perScript: string[][] = [];
    for (const script of scripts) {
      const lines: string[] = [];
      for (const text of script) {
        const speech = toSpeech(text);
        if (!speech || seen.has(speech)) continue;
        seen.add(speech);
        lines.push(speech);
      }
      perScript.push(lines);
    }
    const total = seen.size;
    if (total === 0) return;

    let done = 0;
    const bump = () => {
      done++;
      opts?.onProgress?.(done, total);
    };

    const jobs: (() => Promise<void>)[] = [];
    for (const lines of perScript) {
      const remaining: string[] = [];
      for (const speech of lines) {
        if (await this.hasOriginal(speech)) {
          jobs.push(async () => {
            await this.load(speech);
            bump();
          });
        } else {
          remaining.push(speech);
        }
      }
      for (const chunk of chunkLines(remaining)) {
        jobs.push(() => this.prepareChunk(chunk, bump, opts?.onLog));
      }
    }
    if (jobs.length === 0) return;

    let failed = false;
    let next = 0;
    const worker = async () => {
      while (!failed) {
        const index = next++;
        if (index >= jobs.length) return;
        try {
          await jobs[index]();
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    const workers = Math.min(this.concurrency, jobs.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  /** ログ用。モデルと声と速さ（API キーは含めない） */
  describe(): string {
    return `${this.model} / ${this.voice} / ${formatTempo(this.tempo)} 倍速`;
  }

  private cachePath(speech: string): string {
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          v: 3,
          baseUrl: this.baseUrl,
          model: this.model,
          voice: this.voice,
          style: this.style,
          speech,
        }),
      )
      .digest("hex");
    return path.join(this.cacheDir, `${key}.pcm`);
  }

  private load(speech: string): Promise<NarrationClip> {
    const file = this.outputPath(speech);
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

    const original = this.cachePath(speech);
    if (file !== original) {
      await this.ensureOriginal(speech);
      return this.applyTempo(original, file);
    }

    const pcm = await this.synthesize(speech);
    await this.writeAtomic(file, pcm);
    return { file, duration: pcm.length / BYTES_PER_SECOND };
  }

  /** 無音を削った合成結果。速さはかけない */
  private async ensureOriginal(speech: string): Promise<void> {
    const file = this.cachePath(speech);
    if (await readCached(file)) return;
    const pcm = await this.synthesize(speech);
    await this.writeAtomic(file, pcm);
  }

  /** 元の PCM を atempo で速め、一時ファイルから rename して置く */
  private async applyTempo(original: string, file: string): Promise<NarrationClip> {
    await mkdir(this.cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await run("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        "-i",
        original,
        "-af",
        `atempo=${formatTempo(this.tempo)}`,
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        "1",
        tmp,
      ]);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const written = await readCached(file);
    if (!written) throw new Error("速めた音声を書き出せませんでした");
    return written;
  }

  private async writeAtomic(file: string, pcm: Buffer): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, pcm);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** API から音声を受け取り、無音を削った 24kHz モノラル s16le にする */
  private async synthesize(speech: string): Promise<Buffer> {
    const audio = await this.fetchAudio(speech, this.style);
    return this.decodeAudio(audio, true);
  }

  private async decodeAudio(audio: FetchedAudio, silence: boolean): Promise<Buffer> {
    await mkdir(this.cacheDir, { recursive: true });
    const id = randomBytes(8).toString("hex");
    const src = path.join(this.cacheDir, `${id}${audio.ext}`);
    const out = path.join(this.cacheDir, `${id}.out.pcm`);
    await writeFile(src, audio.bytes);
    try {
      const args = ["-y", "-loglevel", "error"];
      if (audio.kind === "pcm") args.push("-f", "s16le", "-ar", String(audio.rate), "-ac", "1");
      args.push("-i", src);
      if (silence) args.push("-af", SILENCE_FILTER);
      args.push("-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", out);
      await run("ffmpeg", args);
      return await readFile(out);
    } finally {
      await rm(src, { force: true });
      await rm(out, { force: true });
    }
  }

  private async fetchAudio(speech: string, style: string): Promise<FetchedAudio> {
    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: speech, speechMetadata: { style } }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
      },
    });

    let lastError = "音声の生成に失敗しました";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        this.requests++;
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
          if (res.status === 429) {
            const delay = retryDelayMs(parsed);
            if (delay != null && delay > DAILY_QUOTA_WAIT_MS) {
              throw new FatalNarrationError(
                `1 日あたりの上限に達した可能性があります。時間をおいて撮り直してください。${lastError}`,
              );
            }
            if (attempt === MAX_ATTEMPTS - 1) break;
            await sleep(delay ?? backoffMs(attempt));
            continue;
          }
          if (attempt === MAX_ATTEMPTS - 1) break;
          await sleep(backoffMs(attempt));
          continue;
        }
        if (!res.ok) {
          throw new FatalNarrationError(httpError(res.status, parsed, this.model, this.#apiKey));
        }

        const inline = extractInlineAudio(parsed);
        if (!inline) {
          lastError = NO_AUDIO_MESSAGE;
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

  private async hasOriginal(speech: string): Promise<boolean> {
    return (await readCached(this.cachePath(speech))) != null;
  }

  /** 速めたファイル。倍率が 1 のときは合成したファイルそのもの */
  private outputPath(speech: string): string {
    const original = this.cachePath(speech);
    if (this.tempo === 1) return original;
    return `${original.slice(0, -4)}.t${formatTempo(this.tempo)}.pcm`;
  }

  /** 1 文は load、2 文以上はまとめ読み。失敗したら 1 回だけ読み直し、それでもだめなら 1 文ずつ */
  private async prepareChunk(speeches: string[], bump: () => void, onLog?: (message: string) => void): Promise<void> {
    if (speeches.length < 2) {
      for (const speech of speeches) {
        await this.load(speech);
        bump();
      }
      return;
    }
    let wrote = await this.tryReadScript(speeches);
    if (!wrote) wrote = await this.tryReadScript(speeches);
    if (!wrote) {
      onLog?.(`台本を切り分けられなかったので、1 文ずつ読み上げます（${speeches.length} 文）`);
      for (const speech of speeches) {
        await this.load(speech);
        bump();
      }
      return;
    }
    for (const speech of speeches) {
      await this.load(speech);
      bump();
    }
  }

  /**
   * まとめて 1 回読み、文ごとに切り分けて元のキャッシュへ書く。
   * 音声が無い、または切り分けられないときは false。FatalNarrationError はそのまま投げる。
   */
  private async tryReadScript(speeches: string[]): Promise<boolean> {
    let pcm: Buffer;
    try {
      const audio = await this.fetchAudio(speeches.join("\n\n"), `${this.style} ${SCRIPT_STYLE}`);
      pcm = await this.decodeAudio(audio, false);
    } catch (err) {
      if (err instanceof FatalNarrationError) throw err;
      if (isNoAudio(err)) return false;
      throw err;
    }
    if (pcm.length < 2) return false;
    const ranges = splitScript(
      pcm,
      speeches.map((speech) => scriptWeight(speech)),
    );
    if (!ranges || ranges.length !== speeches.length) return false;
    const trimmed: Buffer[] = [];
    for (const range of ranges) {
      trimmed.push(await this.trimSilence(pcm.subarray(range.start, range.end)));
    }
    for (let i = 0; i < speeches.length; i++) {
      await this.writeAtomic(this.cachePath(speeches[i]), trimmed[i]);
    }
    return true;
  }

  /** 切り分けた 1 文に、1 文合成と同じ無音除去をかける */
  private trimSilence(pcm: Buffer): Promise<Buffer> {
    return this.decodeAudio({ bytes: pcm, kind: "pcm", rate: SAMPLE_RATE, ext: ".raw" }, true);
  }
}

/**
 * 読み上げにかかる長さの見込み。空白は数えない。
 * ひらがな・カタカナ・「ー」は 1、漢字・「々」は 1.8。
 * ASCII の英数字は、1 文字だけなら 2、2 文字以上の連続は 1 文字 0.9。
 * 読点は 2.5、句点・感嘆符・疑問符は 4。それ以外は 0。
 */
export function scriptWeight(speech: string): number {
  const chars = Array.from(speech);
  let total = 0;
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i];
    if (isSpeechSpace(ch)) {
      i++;
      continue;
    }
    if (isAsciiAlnum(ch)) {
      let j = i + 1;
      while (j < chars.length && isAsciiAlnum(chars[j])) j++;
      const len = j - i;
      total += len === 1 ? 2 : len * 0.9;
      i = j;
      continue;
    }
    total += speechCharWeight(ch);
    i++;
  }
  return total;
}

/**
 * 24kHz モノラル s16le を、文ごとの重みと無音の位置で切り分ける。
 * 返り値は文ごとの [start, end) バイト位置（2 の倍数）。切れなければ null。
 */
export function splitScript(pcm: Buffer, weights: number[]): { start: number; end: number }[] | null {
  const n = weights.length;
  if (n === 0) return null;
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) return null;
  const sumW = weights.reduce((sum, w) => sum + w, 0);
  if (sumW <= 0) return null;

  const frameCount = Math.floor(pcm.length / FRAME_BYTES);
  if (frameCount === 0) return null;

  const silent = new Array<boolean>(frameCount);
  let first = -1;
  let last = -1;
  for (let i = 0; i < frameCount; i++) {
    silent[i] = frameDb(pcm, i) < -45;
    if (!silent[i]) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last < first) return null;

  const speechStart = first * FRAME_SAMPLES;
  const speechEnd = (last + 1) * FRAME_SAMPLES;
  const ranges =
    n === 1 ? [{ start: speechStart * 2, end: speechEnd * 2 }] : cutBySilence(silent, first, last, weights, sumW);
  if (!ranges) return null;
  return acceptRanges(silent, ranges, weights, sumW) ? ranges : null;
}

function speechCharWeight(ch: string): number {
  if (ch === "、" || ch === "，" || ch === "," || ch === "・") return 2.5;
  if (ch === "。" || ch === "．" || ch === "！" || ch === "？" || ch === "!" || ch === "?") return 4;
  if (isKana(ch) || ch === "ー") return 1;
  if (isKanji(ch)) return 1.8;
  return 0;
}

function isSpeechSpace(ch: string): boolean {
  return /\s/u.test(ch);
}

function isAsciiAlnum(ch: string): boolean {
  return ch.length === 1 && ((ch >= "0" && ch <= "9") || (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z"));
}

function isKana(ch: string): boolean {
  const c = ch.codePointAt(0);
  if (c == null) return false;
  return (c >= 0x3041 && c <= 0x3096) || (c >= 0x30a1 && c <= 0x30fa) || c === 0x30fc;
}

function isKanji(ch: string): boolean {
  const c = ch.codePointAt(0);
  if (c == null) return false;
  return c === 0x3005 || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff);
}

/** 10ms 区間の平均二乗を dB にする。x は -1〜1 */
function frameDb(pcm: Buffer, frame: number): number {
  const start = frame * FRAME_BYTES;
  let sumSq = 0;
  for (let s = 0; s < FRAME_SAMPLES; s++) {
    const x = pcm.readInt16LE(start + s * 2) / 32768;
    sumSq += x * x;
  }
  const mean = sumSq / FRAME_SAMPLES;
  if (mean <= 0) return Number.NEGATIVE_INFINITY;
  return 10 * Math.log10(mean);
}

type SilenceCand = { centerSample: number; lengthSec: number };

/** 発話の内側にある 150ms 以上の無音を、重みから見込んだ位置に動的計画法で割り当てる */
function cutBySilence(
  silent: boolean[],
  first: number,
  last: number,
  weights: number[],
  sumW: number,
): { start: number; end: number }[] | null {
  const n = weights.length;
  const cands: SilenceCand[] = [];
  let run = -1;
  for (let i = first; i <= last; i++) {
    if (silent[i]) {
      if (run < 0) run = i;
      continue;
    }
    if (run >= 0) {
      pushSilence(cands, run, i, first, last);
      run = -1;
    }
  }

  const need = n - 1;
  if (cands.length < need) return null;

  const speechStart = first * FRAME_SAMPLES;
  const speechEnd = (last + 1) * FRAME_SAMPLES;
  const dSec = (speechEnd - speechStart) / SAMPLE_RATE;
  if (!(dSec > 0)) return null;

  let acc = 0;
  const expected: number[] = [];
  for (let k = 0; k < need; k++) {
    acc += weights[k];
    expected.push((speechStart + (dSec * acc * SAMPLE_RATE) / sumW) / SAMPLE_RATE);
  }

  const chosen = chooseCuts(cands, expected, dSec);
  if (!chosen) return null;

  const bounds = [speechStart, ...chosen.map((j) => cands[j].centerSample), speechEnd];
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) {
    const start = bounds[i] * 2;
    const end = bounds[i + 1] * 2;
    if (end <= start) return null;
    ranges.push({ start, end });
  }
  return ranges;
}

function pushSilence(cands: SilenceCand[], run: number, endFrame: number, first: number, last: number): void {
  const runFrames = endFrame - run;
  // 発話範囲の端に接する無音は、文の区切りに使わない
  if (runFrames < 15 || run <= first || endFrame - 1 >= last) return;
  const startSample = run * FRAME_SAMPLES;
  const endSample = endFrame * FRAME_SAMPLES;
  cands.push({
    centerSample: (startSample + endSample) / 2,
    lengthSec: (endSample - startSample) / SAMPLE_RATE,
  });
}

/** Σ (|c − b| / D − min(L, 2) / 2) が最小になる、増加する候補列 */
function chooseCuts(cands: SilenceCand[], expected: number[], dSec: number): number[] | null {
  const need = expected.length;
  const count = cands.length;
  const inf = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: need }, () => Array<number>(count).fill(inf));
  const prev: number[][] = Array.from({ length: need }, () => Array<number>(count).fill(-1));
  const cost = (k: number, j: number) => {
    const cand = cands[j];
    return Math.abs(cand.centerSample / SAMPLE_RATE - expected[k]) / dSec - Math.min(cand.lengthSec, 2) / 2;
  };

  for (let j = 0; j < count; j++) dp[0][j] = cost(0, j);
  for (let k = 1; k < need; k++) {
    for (let j = k; j < count; j++) {
      let best = inf;
      let bestP = -1;
      for (let p = k - 1; p < j; p++) {
        if (dp[k - 1][p] < best) {
          best = dp[k - 1][p];
          bestP = p;
        }
      }
      if (bestP >= 0) {
        dp[k][j] = best + cost(k, j);
        prev[k][j] = bestP;
      }
    }
  }

  let best = inf;
  let bestJ = -1;
  for (let j = need - 1; j < count; j++) {
    if (dp[need - 1][j] < best) {
      best = dp[need - 1][j];
      bestJ = j;
    }
  }
  if (bestJ < 0 || !Number.isFinite(best)) return null;

  const chosen: number[] = [];
  let j = bestJ;
  for (let k = need - 1; k >= 0; k--) {
    chosen.push(j);
    if (k > 0) j = prev[k][j];
  }
  chosen.reverse();
  return chosen;
}

/** 各文の有音の長さが、重みから見込んだ長さの 0.5〜2 倍で、かつ 0.25 秒以上 */
function acceptRanges(silent: boolean[], ranges: { start: number; end: number }[], weights: number[], sumW: number): boolean {
  const ds: number[] = [];
  for (const range of ranges) {
    const startSample = range.start / 2;
    const endSample = range.end / 2;
    if (range.start % 2 !== 0 || range.end % 2 !== 0 || endSample <= startSample) return false;
    let firstSample = -1;
    let lastSample = -1;
    const frameCount = silent.length;
    for (let i = 0; i < frameCount; i++) {
      if (silent[i]) continue;
      const fs = i * FRAME_SAMPLES;
      const fe = fs + FRAME_SAMPLES;
      if (fs < startSample || fe > endSample) continue;
      if (firstSample < 0) firstSample = fs;
      lastSample = fe;
    }
    if (firstSample < 0) return false;
    const samples = lastSample - firstSample;
    if (samples < SAMPLE_RATE * 0.25) return false;
    ds.push(samples / SAMPLE_RATE);
  }
  const sumD = ds.reduce((sum, d) => sum + d, 0);
  for (let i = 0; i < ds.length; i++) {
    const e = (sumD * weights[i]) / sumW;
    if (!(e > 0)) return false;
    const ratio = ds[i] / e;
    if (ratio < 0.5 || ratio > 2) return false;
  }
  return true;
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

/** 有限で 0.5 以上 2 以下なら小数 2 桁。それ以外は既定 */
function normalizeTempo(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 0.5 || value > 2) return DEFAULT_TEMPO;
  return Math.round(value * 100) / 100;
}

/** 1.2 や 1.25 のように、末尾の 0 を付けない */
function formatTempo(tempo: number): string {
  return tempo.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 0 / false / off（大文字小文字は問わない）ならまとめ読みを切る。それ以外は有効 */
function parseBatch(value: string | undefined): boolean {
  if (value == null) return true;
  const v = value.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/** 最大 8 文。まとまりの数は ceil(n/8)、1 つは ceil(n/まとまりの数) で均等に分ける */
function chunkLines(lines: string[]): string[][] {
  const n = lines.length;
  if (n === 0) return [];
  const chunks = Math.ceil(n / MAX_SCRIPT_LINES);
  const size = Math.ceil(n / chunks);
  const out: string[][] = [];
  for (let i = 0; i < n; i += size) out.push(lines.slice(i, i + size));
  return out;
}

function isNoAudio(err: unknown): boolean {
  return err instanceof Error && err.message === NO_AUDIO_MESSAGE;
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

/** 応答に retryDelay が無ければ null（呼び出し側がバックオフと区別する） */
function retryDelayMs(body: unknown): number | null {
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
  return null;
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
