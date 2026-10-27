#!/usr/bin/env node
// Cloudflare の初期設定（初回だけ実行）
//   1. wrangler にログインしているか確認
//   2. D1 データベース「sen-db」を作成（すでにあれば再利用）
//   3. wrangler.jsonc の database_id を書き換える
//   4. スキーマを本番 D1 に適用
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "wrangler.jsonc");
const DB_NAME = "sen-db";

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", ...opts });
}
function step(msg) {
  console.log(`\n\x1b[36m▸ ${msg}\x1b[0m`);
}

step("Cloudflare のログイン状態を確認しています");
try {
  const who = sh("npx wrangler whoami");
  if (/not authenticated|You are not logged in/i.test(who)) throw new Error("not logged in");
  console.log(who.split("\n").filter((l) => /account|email|logged/i.test(l)).join("\n"));
} catch {
  console.log("ログインしていません。ブラウザが開くので Cloudflare にログインしてください。");
  execSync("npx wrangler login", { cwd: root, stdio: "inherit" });
}

step(`D1 データベース「${DB_NAME}」を用意しています`);
const findDb = () => {
  const list = JSON.parse(sh("npx wrangler d1 list --json"));
  return list.find((d) => d.name === DB_NAME);
};
let db = findDb();
if (!db) {
  execSync(`npx wrangler d1 create ${DB_NAME} --location apac`, { cwd: root, stdio: "inherit" });
  db = findDb();
}
if (!db) throw new Error("D1 データベースを作成できませんでした");
const id = db.uuid ?? db.database_id ?? db.id;
console.log(`database_id: ${id}`);

step("wrangler.jsonc を更新しています");
const config = readFileSync(configPath, "utf8");
const next = config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
writeFileSync(configPath, next);
console.log(next === config ? "変更はありません" : "database_id を書き込みました");

step("スキーマを本番の D1 に適用しています");
execSync(`npx wrangler d1 migrations apply ${DB_NAME} --remote`, { cwd: root, stdio: "inherit" });

console.log(`\n\x1b[32m✓ 準備ができました。\x1b[0m 次のコマンドでデプロイします:\n\n  npm run deploy\n`);
