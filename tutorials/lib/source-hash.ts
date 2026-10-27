import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// 動画が「いまの画面」で撮られたものかを判定するためのハッシュ。
// アプリの画面（src/）・収録の仕組み（tutorials/lib/）・そのシナリオが変わると値が変わる。

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

let shared: string | null = null;

export async function sourceHash(root: string, scenarioFile: string): Promise<string> {
  if (!shared) {
    const h = createHash("sha256");
    for (const dir of ["src", "tutorials/lib"]) {
      for (const f of await listFiles(path.join(root, dir))) {
        h.update(path.relative(root, f));
        h.update(await readFile(f));
      }
    }
    shared = h.digest("hex");
  }
  const h = createHash("sha256");
  h.update(shared);
  h.update(await readFile(scenarioFile));
  return h.digest("hex").slice(0, 16);
}
