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

export class Director {
  chapters: Chapter[] = [];
  private step = 0;
  private mouse = { x: 640, y: 420 };

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

  /** 字幕を出してチャプターとして記録する。読み終わるまでの時間だけ待つ */
  async caption(text: string, opts: { hold?: number; chapter?: boolean } = {}) {
    if (opts.chapter !== false) {
      this.step++;
      this.chapters.push({ t: Math.max(0, (this.recorder?.elapsed() ?? 0) - 0.2), title: text });
    }
    await this.page.evaluate(
      ([t, s]) => (window as never as { __tutor: { caption: Function } }).__tutor.caption(t, s),
      [text, opts.chapter === false ? null : this.step] as const,
    );
    const reading = 900 + [...text].length * 75;
    await this.wait(opts.hold ?? reading);
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
