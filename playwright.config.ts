import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4320);
const GOOGLE_PORT = Number(process.env.E2E_GOOGLE_PORT ?? 4329);
const ANTHROPIC_PORT = Number(process.env.E2E_ANTHROPIC_PORT ?? 4330);
const persist = path.join(os.tmpdir(), "sen-e2e-state");
const sheetsVarsPath = path.join(os.tmpdir(), "sen-e2e-sheets.vars");
const sheetsPublicPath = path.join(os.tmpdir(), "sen-e2e-sheets-public.pem");
// Google ログインは「Google の画面へ移るところ」までを確かめるので、ダミーの認証情報を使う。
// ビルドが書き出す dist/sen/.dev.vars の末尾に足すと、手元の .env.local の値より優先される。
const GOOGLE_DUMMY = "GOOGLE_CLIENT_ID=e2e-google-client-id\\nGOOGLE_CLIENT_SECRET=e2e-google-client-secret\\n";
// AI アシスタントは模擬の Claude に向ける。GOOGLE_DUMMY と同じく、ビルド後の .dev.vars の末尾に足す。
const ANTHROPIC_DUMMY = `ANTHROPIC_API_KEY=e2e-anthropic-key\\nANTHROPIC_API_ORIGIN_FOR_TESTS=http://localhost:${ANTHROPIC_PORT}\\nASSISTANT_DAILY_LIMIT=3\\n`;

// ワーカーは設定を読み直すだけなので、鍵の生成はメインプロセス（TEST_WORKER_INDEX が無いとき）だけが行う。
// 手元では reuseExistingServer で前回のサーバーを使い回すことがある。そのとき鍵を作り直してファイルを上書きすると、
// サーバーは古い秘密鍵で署名し、テストは新しい公開鍵で確かめるので、署名の検証が失敗する。
// 両方のファイルがあり、かつ vars に今のポートの GOOGLE_API_ORIGIN_FOR_TESTS=http://localhost:<port> の行があるときは
// 鍵を作らず書き換えない。ファイルが無い、またはポートが違うときは作り直して両方を書く。
const sheetsOriginLine = `GOOGLE_API_ORIGIN_FOR_TESTS=http://localhost:${GOOGLE_PORT}`;
function sheetsVarsMatchCurrentPort(): boolean {
  if (!fs.existsSync(sheetsVarsPath) || !fs.existsSync(sheetsPublicPath)) return false;
  return fs.readFileSync(sheetsVarsPath, "utf8").split(/\r?\n/).includes(sheetsOriginLine);
}

if (!process.env.TEST_WORKER_INDEX && !sheetsVarsMatchCurrentPort()) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const serviceAccount = JSON.stringify({
    type: "service_account",
    client_email: "sen-e2e@sen-e2e.iam.gserviceaccount.com",
    private_key: privateKey,
  });
  fs.writeFileSync(
    sheetsVarsPath,
    [
      "SHEETS_WORKSPACE=sheets-e2e",
      "SHEETS_SPREADSHEET_ID=e2e-spreadsheet",
      "SHEETS_SYNC_DELAY_MS=1000",
      sheetsOriginLine,
      `GOOGLE_SERVICE_ACCOUNT_KEY='${serviceAccount}'`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(sheetsPublicPath, publicKey);
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1360, height: 860 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } }],
  webServer: {
    // 毎回まっさらな DB で、本番と同じビルドを動かす
    command: `rm -rf ${persist} && bunx vite build && printf '${GOOGLE_DUMMY}' >> dist/sen/.dev.vars && cat '${sheetsVarsPath}' >> dist/sen/.dev.vars && printf '${ANTHROPIC_DUMMY}' >> dist/sen/.dev.vars && bunx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/health`,
    env: { SEN_PERSIST_DIR: persist, PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
