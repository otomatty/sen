#!/usr/bin/env node
// デプロイ前の安全チェック
//  - ローカル開発用の .dev.vars（DEV_TOOLS=1）を本番の成果物から取り除く
//  - D1 の database_id が仮の値のままなら止める
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devVars = path.join(root, "dist", "sen", ".dev.vars");
if (existsSync(devVars)) {
  rmSync(devVars);
  console.log("dist/sen/.dev.vars を削除しました（開発用の設定を本番に含めないため）");
}
const config = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
if (/"database_id"\s*:\s*"0{8}-0{4}-0{4}-0{4}-0{12}"/.test(config)) {
  console.error("\n✗ wrangler.jsonc の database_id が未設定です。先に `bun run cf:setup` を実行してください。\n");
  process.exit(1);
}
