import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * Google を通さずにログインする（DEV_TOOLS=1 のときだけ使える開発用のログイン。@example.com のアドレスに限る）。
 * page.request はブラウザと Cookie を共有するので、このページはログイン済みになる。
 */
export async function devSignIn(page: Page, opts: { name?: string; email?: string } = {}) {
  const email = opts.email ?? uniqueEmail();
  const r = await page.request.post("/api/auth/dev/sign-in", {
    data: { email, name: opts.name ?? "テスト 太郎" },
    // Better Auth は Cookie 付きの POST に Origin を求める（ログイン途中の Cookie が残っている場合など）
    headers: { "x-sen-client": "1", origin: new URL(test.info().project.use.baseURL!).origin },
  });
  expect(r.ok()).toBeTruthy();
  return email;
}

/** 初めてログインし、画面からワークスペースを作って入る */
export async function signupViaUi(page: Page, opts: { name?: string; email?: string; workspace?: string } = {}) {
  const email = await devSignIn(page, opts);
  await page.goto("/");
  await expect(page.getByTestId("new-workspace-form")).toBeVisible();
  if (opts.workspace) await page.getByTestId("new-workspace-name").fill(opts.workspace);
  await page.getByTestId("new-workspace-submit").click();
  await expect(page.getByTestId("app")).toBeVisible();
  await dismissWelcome(page);
  const ws = new URL(page.url()).pathname.split("/")[1];
  return { email, ws };
}

export async function dismissWelcome(page: Page) {
  const welcome = page.getByTestId("welcome-modal");
  if (await welcome.isVisible().catch(() => false)) {
    await page.getByTestId("welcome-start").click();
  } else {
    // 表示が少し遅れる場合に備えて待つ
    try {
      await welcome.waitFor({ state: "visible", timeout: 1500 });
      await page.getByTestId("welcome-start").click();
    } catch {
      // 表示されなければ何もしない
    }
  }
  await expect(welcome).toBeHidden();
}

/** デモ用のチームメンバー・課題をまとめて投入する（DEV_TOOLS=1 のときだけ動く） */
export async function seedDemo(request: APIRequestContext, ws: string) {
  const r = await request.post(`/api/dev/seed-demo?ws=${ws}`, { headers: { "x-sen-client": "1" } });
  expect(r.ok()).toBeTruthy();
}

export async function newUserPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

export async function waitForSynced(page: Page) {
  await expect(page.getByTestId("sync-status")).toContainText("同期済み", { timeout: 15_000 });
}

export function row(page: Page, identifier: string) {
  return page.locator(`[data-testid=issue-row][data-identifier='${identifier}']`);
}
