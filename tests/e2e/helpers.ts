import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/** テストごとに衝突しないメールアドレス。domain を省略すると example.com（サブドメインは許可ドメインの判定で別物） */
export function uniqueEmail(prefix = "user", domain = "example.com") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@${domain}`;
}

/**
 * Google を通さずにログインする（DEV_TOOLS=1 のときだけ使える開発用のログイン。@example.com とそのサブドメインに限る）。
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

/** 招待リンクからパスだけを取り出す（別オリジンの絶対 URL でも、このサーバーのパスとして開ける） */
export function invitePath(link: string): string {
  if (link.startsWith("/")) return link;
  const url = new URL(link);
  return url.pathname + url.search;
}

/** 招待リンクのトークン */
export function inviteToken(link: string): string {
  const token = invitePath(link).split("/invite/")[1]?.split(/[?#]/)[0];
  if (!token) throw new Error(`招待リンクからトークンを取り出せません: ${link}`);
  return decodeURIComponent(token);
}

/**
 * 設定 → メンバーからメールで招待し、結果に出た招待リンクを返す。
 * 招待中の一覧に載るまで待つ。
 */
export async function inviteByEmail(page: Page, ws: string, email: string, role: "admin" | "member" = "member"): Promise<string> {
  await page.goto(`/${ws}/settings/members`);
  await expect(page.getByTestId("invite-emails")).toBeVisible();
  await page.getByTestId("invite-emails").fill(email);
  if (role !== "member") await page.getByTestId("invite-role").selectOption(role);
  await page.getByTestId("invite-submit").click();
  const result = page.locator(`[data-testid="invite-result"][data-email="${email}"]`);
  const link = result.getByTestId("invite-result-link");
  await expect(link).toBeVisible();
  const value = await link.inputValue();
  expect(value).toContain("/invite/");
  await expect(page.locator(`[data-testid="invitation-row"][data-email="${email}"]`)).toBeVisible();
  return value;
}

/** 別のブラウザで、招待したアドレスとしてログインして参加する */
export async function joinByInvite(browser: Browser, link: string, opts: { email: string; name?: string }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await devSignIn(page, { email: opts.email, name: opts.name });
    await page.goto(invitePath(link));
    await page.getByTestId("invite-accept").click();
    await expect(page.getByTestId("app")).toBeVisible();
    await dismissWelcome(page);
    return { context, page };
  } catch (e) {
    await context.close();
    throw e;
  }
}

export async function waitForSynced(page: Page) {
  await expect(page.getByTestId("sync-status")).toContainText("同期済み", { timeout: 15_000 });
}

export function row(page: Page, identifier: string) {
  return page.locator(`[data-testid=issue-row][data-identifier='${identifier}']`);
}
