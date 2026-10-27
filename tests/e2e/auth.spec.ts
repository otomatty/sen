import { expect, test } from "@playwright/test";
import { devSignIn, dismissWelcome, seedDemo, signupViaUi } from "./helpers";

test("初めてログインするとワークスペースを作る画面になり、サンプル課題入りのワークスペースが作られる", async ({ page }) => {
  await signupViaUi(page, { name: "鈴木 次郎", workspace: "テスト株式会社" });
  await expect(page.getByTestId("sidebar")).toContainText("テスト株式会社");
  await page.getByTestId("nav-team-ENG-issues").click();
  await expect(page.getByTestId("issue-row").filter({ hasText: "Sen へようこそ" })).toBeVisible();
  await expect(page.getByTestId("issue-row")).toHaveCount(9);
});

test("ログイン画面は Google でのログインだけ", async ({ page }) => {
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("google-sign-in")).toHaveText("Google でログイン");
  await expect(page.locator("input")).toHaveCount(0);
});

test("Google の画面へ移り、キャンセルするとログイン画面に理由が表示される", async ({ page, context, baseURL }) => {
  let authUrl: URL | null = null;
  // 本物の Google には行かず、利用者が「キャンセル」を押したことにしてアプリへ戻す
  await context.route("https://accounts.google.com/**", (route) => {
    authUrl = new URL(route.request().url());
    const back = new URL(authUrl.searchParams.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", authUrl.searchParams.get("state")!);
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.goto("/some-workspace/my-issues");
  await page.getByTestId("google-sign-in").click();
  await expect(page.getByTestId("auth-error")).toContainText("キャンセルされました");
  await expect(page).toHaveURL(/\/login\?next=%2Fsome-workspace%2Fmy-issues&error=access_denied$/);

  const url = authUrl as URL | null;
  expect(url?.origin + url!.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url!.searchParams.get("client_id")).toBe("e2e-google-client-id");
  expect(url!.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/google`);
  expect(url!.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid", "profile"]);
});

test("ログアウトしてログインし直すと、同じワークスペースに戻れる", async ({ page }) => {
  const { email, ws } = await signupViaUi(page);
  await page.getByTestId("workspace-menu").click();
  await page.getByRole("button", { name: /ログアウト/ }).click();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.goto(`/${ws}/my-issues`);
  await expect(page.getByTestId("login-form")).toBeVisible();

  await devSignIn(page, { email });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${ws}/`));
});

test("未ログインで画面を開くとログインに誘導される", async ({ page }) => {
  await page.goto("/some-workspace/my-issues");
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test("招待リンクから Google でログインすると、そのままワークスペースに参加できる", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  await page.goto(`/${ws}/settings/members`);
  const code = (await page.getByTestId("invite-link").inputValue()).split("/invite/")[1];

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await ctx.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "Google" }));
  await p2.goto(`/invite/${code}`);
  await p2.getByTestId("google-sign-in").filter({ hasText: "Google でログインして参加" }).click();
  await expect(p2).toHaveURL(/accounts\.google\.com/);

  // Google でログインして戻ってきたところ（戻り先は /invite/:code?join=1）
  await devSignIn(p2, { name: "新人 次郎" });
  await p2.goto(`/invite/${code}?join=1`);
  await expect(p2.getByTestId("app")).toBeVisible();
  await dismissWelcome(p2);
  await expect(p2).toHaveURL(new RegExp(`/${ws}/`));
  await ctx.close();
});

test("?join=1 付きの招待リンクを開いただけでは、勝手に参加しない", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  await page.goto(`/${ws}/settings/members`);
  const code = (await page.getByTestId("invite-link").inputValue()).split("/invite/")[1];

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await devSignIn(p2, { name: "別の 人" });
  await p2.goto(`/invite/${code}?join=1`);
  await expect(p2.getByTestId("invite-accept")).toBeVisible();
  await p2.waitForTimeout(1000);
  await expect(p2).toHaveURL(/\/invite\//);
  const me = await (await p2.request.get("/api/me")).json();
  expect(me.workspaces).toEqual([]);
  await ctx.close();
});

test("デモデータのメンバーとして開発用ログインで入れる", async ({ page, browser }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await devSignIn(p2, { email: "hanako@example.com" });
  const me = await (await p2.request.get("/api/me")).json();
  expect(me.user?.name).toBe("佐藤 花子");
  expect(me.workspaces.map((w: { urlKey: string }) => w.urlKey)).toContain(ws);
  await ctx.close();
});
