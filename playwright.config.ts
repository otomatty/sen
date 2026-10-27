import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 4320);
const persist = path.join(os.tmpdir(), "sen-e2e-state");
// Google ログインは「Google の画面へ移るところ」までを確かめるので、ダミーの認証情報を使う。
// ビルドが書き出す dist/sen/.dev.vars の末尾に足すと、手元の .env.local の値より優先される。
const GOOGLE_DUMMY = "GOOGLE_CLIENT_ID=e2e-google-client-id\\nGOOGLE_CLIENT_SECRET=e2e-google-client-secret\\n";

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
    command: `rm -rf ${persist} && npx vite build && printf '${GOOGLE_DUMMY}' >> dist/sen/.dev.vars && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/health`,
    env: { SEN_PERSIST_DIR: persist, PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
