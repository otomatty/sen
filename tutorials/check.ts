/**
 * 使い方動画が最新の画面で撮られているかを確かめる。
 *   bun run tutorials:check
 * 画面やシナリオを変えたのに撮り直していない動画があれば一覧を出して終了コード 1 で終わる。
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceHash } from "./lib/source-hash";
import type { Scenario } from "./lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(ROOT, "public/tutorials/manifest.json"), "utf8")) as {
  tutorials: { id: string; sourceHash?: string }[];
};
const dir = path.join(ROOT, "tutorials/scenarios");
const stale: string[] = [];
for (const f of (await readdir(dir)).filter((x) => x.endsWith(".ts")).sort()) {
  const file = path.join(dir, f);
  const s = ((await import(pathToFileURL(file).href)) as { default: Scenario }).default;
  const entry = manifest.tutorials.find((x) => x.id === s.id);
  const hash = await sourceHash(ROOT, file);
  if (!entry) stale.push(`${s.id}（未収録）`);
  else if (entry.sourceHash !== hash) stale.push(`${s.id}（画面かシナリオが変わっています）`);
}
if (stale.length) {
  console.error(`撮り直しが必要な動画があります（bun run tutorials）:\n- ${stale.join("\n- ")}`);
  process.exit(1);
}
console.log(`すべての動画（${manifest.tutorials.length}本）が最新の画面で収録されています。`);
