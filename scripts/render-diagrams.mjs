#!/usr/bin/env node
// ガイドの図（PNG）を docs/diagrams/ の HTML から docs/images/ に書き出す。
//   bun run diagrams
//   bun run diagrams -- team-structure（名前で絞り込み）
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const diagrams = [
  { name: "team-structure", width: 912, height: 432 },
  { name: "issue-links", width: 912, height: 432 },
  { name: "projects-and-cycles", width: 912, height: 372 },
];

const names = process.argv.slice(2);
const targets = names.length ? diagrams.filter((d) => names.includes(d.name)) : diagrams;

const browser = await chromium.launch();
try {
  for (const diagram of targets) {
    const html = path.join(root, "docs", "diagrams", `${diagram.name}.html`);
    if (!existsSync(html)) {
      console.log(`${diagram.name} はまだありません`);
      continue;
    }
    for (const scheme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width: diagram.width, height: diagram.height },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      await page.goto(pathToFileURL(html).href);
      await page.evaluate(() => document.fonts.ready);
      const file = `${diagram.name}-${scheme}.png`;
      await page.screenshot({ path: path.join(root, "docs", "images", file) });
      await page.close();
      console.log(`docs/images/${file}`);
    }
  }
} finally {
  await browser.close();
}
