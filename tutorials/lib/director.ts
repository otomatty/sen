import type { Locator, Page } from "playwright";
import type { ScreenRecorder } from "./recorder";

// シナリオから使う操作 API。人が操作しているように見えるよう、
// カーソルを滑らかに動かし、押したキーと字幕を画面に表示しながら操作する。

export interface Chapter {
  t: number;
  title: string;
}

type Target = string | Locator;

const KEY_LABEL: Record<string, string> = {
  Meta: "⌘",
  Control: "Ctrl",
  Shift: "⇧",
  Alt: "⌥",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "⌫",
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  Tab: "Tab",
  Space: "Space",
};

/** キーボード操作の間にカーソルを置いておく場所（サイドバーの空き。ホバーしても何も起きない） */
export const PARK = { x: 110, y: 540 };

export class Director {
  chapters: Chapter[] = [];
  /** t.poster() で撮ったサムネイルの保存先（run.ts が設定する） */
  posterFile: string | null = null;
  posterTaken = false;
  private step = 0;
  private mouse = { x: 640, y: 420 };
  /** 今の字幕が出た時刻と、最低限表示しておく時間（読み終わるまで） */
  private captionAt = 0;
  private captionMin = 0;

  constructor(
    public page: Page,
    public ws: string,
    private recorder: ScreenRecorder | null,
    private speed = 1,
  ) {}

  setMouse(x: number, y: number) {
    this.mouse = { x, y };
  }

  private ms(n: number) {
    return Math.round(n / this.speed);
  }

  async wait(ms: number) {
    await this.page.waitForTimeout(this.ms(ms));
  }

  private locator(t: Target): Locator {
    return typeof t === "string" ? this.page.locator(t).first() : t;
  }

  /** ワークスペース内のパスへ移動して、画面が落ち着くまで待つ */
  async goto(path: string) {
    await this.page.goto(`/${this.ws}${path}`);
    await this.page.waitForSelector("[data-testid=app]");
    await this.wait(600);
  }

  /** 冒頭のタイトルカード */
  async title(badge: string, heading: string, sub: string, ms = 2600) {
    await this.page.evaluate(([b, h, s]) => (window as never as { __tutor: { title: Function } }).__tutor.title(b, h, s), [badge, heading, sub]);
    await this.wait(ms);
    await this.page.evaluate(() => (window as never as { __tutor: { hideTitle: Function } }).__tutor.hideTitle());
    await this.wait(500);
  }

  /**
   * 字幕を出してチャプターとして記録する。
   * 字幕を出したら少しだけ待って操作を始め、操作の結果が字幕と一緒に映るようにする。
   * 読み終わるまでの時間は「次の字幕を出す前」に確保する（結果が画面に残った状態で待つ）。
   */
  async caption(text: string, opts: { hold?: number; chapter?: boolean } = {}) {
    await this.settle();
    if (opts.chapter !== false) {
      this.step++;
      this.chapters.push({ t: Math.max(0, (this.recorder?.elapsed() ?? 0) - 0.2), title: text });
    }
    await this.page.evaluate(
      ([t, s]) => (window as never as { __tutor: { caption: Function } }).__tutor.caption(t, s),
      [text, opts.chapter === false ? null : this.step] as const,
    );
    const chars = [...text].length;
    this.captionAt = Date.now();
    this.captionMin = this.ms(opts.hold ?? 1000 + chars * 70);
    // 読み始める時間だけ待ってから操作に移る
    await this.wait(Math.min(1300, 550 + chars * 18));
  }

  /** 今の字幕を読み終えられるまで待つ（次の字幕の前・収録の終わりに呼ばれる） */
  async settle() {
    const left = this.captionAt + this.captionMin - Date.now();
    if (left > 0) await this.page.waitForTimeout(left);
    this.captionMin = 0;
  }

  /** 収録の締めくくり：最後の字幕を読み終えるまで待ち、余韻を残す */
  async finish() {
    await this.settle();
    await this.wait(900);
  }

  /**
   * 操作の結果を確かめる。期待どおりでなければ収録を失敗させる
   * （壊れた動画を気づかずに公開しないため）
   */
  async expect(target: Target, opts: { text?: string | RegExp; hidden?: boolean; count?: number; timeout?: number } = {}) {
    const loc = typeof target === "string" ? this.page.locator(target) : target;
    const timeout = opts.timeout ?? 5000;
    const label = typeof target === "string" ? target : "locator";
    try {
      if (opts.hidden) await loc.first().waitFor({ state: "hidden", timeout });
      else if (opts.count !== undefined) {
        const deadline = Date.now() + timeout;
        while ((await loc.count()) !== opts.count) {
          if (Date.now() > deadline) throw new Error(`件数が ${await loc.count()}（期待 ${opts.count}）`);
          await this.page.waitForTimeout(100);
        }
      } else {
        await loc.first().waitFor({ state: "visible", timeout });
        if (opts.text !== undefined) {
          const deadline = Date.now() + timeout;
          for (;;) {
            const txt = (await loc.first().textContent()) ?? "";
            if (typeof opts.text === "string" ? txt.includes(opts.text) : opts.text.test(txt)) break;
            if (Date.now() > deadline) throw new Error(`テキストが「${txt.slice(0, 60)}」`);
            await this.page.waitForTimeout(100);
          }
        }
      }
    } catch (e) {
      throw new Error(`確認に失敗（ステップ ${this.step}）：${label} ${opts.text ? `に「${String(opts.text)}」` : ""}${opts.hidden ? "が消える" : ""} — ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /** URL が期待どおりになったかを確かめる */
  async expectUrl(re: RegExp, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!re.test(new URL(this.page.url()).pathname)) {
      if (Date.now() > deadline) throw new Error(`確認に失敗（ステップ ${this.step}）：URL ${this.page.url()} が ${re} に一致しません`);
      await this.page.waitForTimeout(100);
    }
  }

  /** 一覧のサムネイルをこの瞬間の画面で撮る（字幕やキー表示は隠す） */
  async poster() {
    if (!this.posterFile || this.posterTaken) return;
    await this.page.evaluate(() => (window as never as { __tutor: { setHidden: Function } }).__tutor.setHidden(true));
    await this.page.waitForTimeout(120);
    await this.page.screenshot({ path: `${this.posterFile}.full.jpg`, type: "jpeg", quality: 90 });
    await this.page.evaluate(() => (window as never as { __tutor: { setHidden: Function } }).__tutor.setHidden(false));
    this.posterTaken = true;
  }

  /** カーソルを邪魔にならない場所へ移す（キーボード操作の前に） */
  async park() {
    await this.moveToPoint(PARK.x, PARK.y);
  }

  async hideCaption() {
    await this.page.evaluate(() => (window as never as { __tutor: { hideCaption: Function } }).__tutor.hideCaption());
  }

  /** 要素を光らせて注目させる */
  async highlight(target: Target, ms = 1400) {
    const box = await this.locator(target).boundingBox();
    if (!box) return;
    await this.page.evaluate((r) => (window as never as { __tutor: { highlight: Function } }).__tutor.highlight(r), box);
    await this.wait(ms);
    await this.page.evaluate(() => (window as never as { __tutor: { highlight: Function } }).__tutor.highlight(null));
  }

  /** カーソルを要素の中心（または指定位置）へ滑らかに動かす */
  async moveTo(target: Target, opts: { offsetX?: number; offsetY?: number; steps?: number } = {}) {
    const loc = this.locator(target);
    await loc.waitFor({ state: "visible", timeout: 10_000 });
    await loc.scrollIntoViewIfNeeded();
    const box = await loc.boundingBox();
    if (!box) throw new Error(`要素が見つかりません: ${String(target)}`);
    const x = box.x + (opts.offsetX ?? box.width / 2);
    const y = box.y + (opts.offsetY ?? box.height / 2);
    await this.moveToPoint(x, y, opts.steps);
  }

  async moveToPoint(x: number, y: number, steps?: number) {
    const dist = Math.hypot(x - this.mouse.x, y - this.mouse.y);
    const n = steps ?? Math.max(12, Math.min(40, Math.round(dist / 18)));
    // ease-in-out で動かす
    const from = { ...this.mouse };
    for (let i = 1; i <= n; i++) {
      const p = i / n;
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await this.page.waitForTimeout(this.ms(12));
    }
    this.mouse = { x, y };
  }

  async click(target: Target, opts: { offsetX?: number; offsetY?: number; pause?: number } = {}) {
    await this.moveTo(target, opts);
    await this.wait(180);
    await this.page.mouse.down();
    await this.page.waitForTimeout(70);
    await this.page.mouse.up();
    await this.wait(opts.pause ?? 450);
  }

  async hover(target: Target, ms = 500) {
    await this.moveTo(target);
    await this.wait(ms);
  }

  /** 人が打っているような速さで入力する（日本語もそのまま入力される） */
  async type(text: string, opts: { delay?: number } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.page.waitForTimeout(this.ms(opts.delay ?? (/[\x00-\x7F]/.test(ch) ? 45 : 85)));
    }
    await this.wait(250);
  }

  /** キーを押す。画面下に押したキーを大きく表示する（"Meta+k" / "g i" のようなシーケンスにも対応） */
  async press(combo: string, opts: { pause?: number; show?: boolean; label?: string[] } = {}) {
    const seq = combo.split(" ");
    const labels: string[] = [];
    seq.forEach((part, i) => {
      part
        .split(/\+(?=.)/)
        .forEach((k) => labels.push(KEY_LABEL[k] ?? (k.length === 1 ? k.toUpperCase() : k)));
      if (i < seq.length - 1) labels.push("→");
    });
    if (opts.label) labels.splice(0, labels.length, ...opts.label);
    if (opts.show !== false) {
      await this.page.evaluate((parts) => (window as never as { __tutor: { keys: Function } }).__tutor.keys(parts), labels);
      await this.wait(260);
    }
    for (const part of seq) {
      await this.page.keyboard.press(part);
      await this.wait(120);
    }
    await this.wait(opts.pause ?? 650);
  }

  async drag(from: Target, to: Target, opts: { offsetY?: number } = {}) {
    await this.moveTo(from);
    await this.wait(200);
    await this.page.mouse.down();
    await this.wait(150);
    // 少し動かしてドラッグを開始させる
    await this.moveToPoint(this.mouse.x + 8, this.mouse.y + 6, 4);
    await this.moveTo(to, { offsetY: opts.offsetY, steps: 40 });
    await this.wait(300);
    await this.page.mouse.up();
    await this.wait(600);
  }

  async scroll(target: Target, dy: number) {
    await this.moveTo(target);
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      await this.page.mouse.wheel(0, dy / steps);
      await this.page.waitForTimeout(this.ms(25));
    }
    await this.wait(400);
  }

  locate(selector: string) {
    return this.page.locator(selector).first();
  }
}
