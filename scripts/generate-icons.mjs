#!/usr/bin/env node
// PWA 用のアイコン（PNG）を、favicon.svg と同じ図柄から public/icons/ に書き出す。
//   bun run icons
// 図柄を変えたら public/favicon.svg と src/components/icons.tsx の Logo もそろえて直す。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "icons");
const ACCENT = "#6470e8";

const MARK =
  '<path d="M6.5 16.5 17.5 6.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>' +
  '<path d="M6.5 11 12 6.5M12 17.5l5.5-5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>';

// any: 角丸の四角（favicon と同じ）。maskable / apple-touch-icon: 端まで塗る（角の丸めは OS が行う）。
// maskable は円形に切り抜かれても欠けないよう、図柄を中央の安全領域（直径 80%）に収める。
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${ACCENT}"/>${MARK}</svg>`;
const fullBleed = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="${ACCENT}"/><g transform="translate(12 12) scale(${scale}) translate(-12 -12)">${MARK}</g></svg>`;

const icons = [
  { file: "icon-192.png", size: 192, svg: rounded },
  { file: "icon-512.png", size: 512, svg: rounded },
  { file: "maskable-192.png", size: 192, svg: fullBleed(0.8) },
  { file: "maskable-512.png", size: 512, svg: fullBleed(0.8) },
  { file: "apple-touch-icon.png", size: 180, svg: fullBleed(0.9) },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${icon.svg.replace("<svg ", `<svg width="${icon.size}" height="${icon.size}" style="display:block" `)}</body></html>`,
    );
    await page.screenshot({ path: path.join(out, icon.file), omitBackground: true });
    await page.close();
    console.log(`public/icons/${icon.file}（${icon.size}×${icon.size}）`);
  }
} finally {
  await browser.close();
}
