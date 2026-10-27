import { expect, test } from "@playwright/test";
import { PASSWORD, signupViaUi, uniqueEmail } from "./helpers";

test("サインアップするとサンプル課題入りのワークスペースが作られる", async ({ page }) => {
  await signupViaUi(page, { name: "鈴木 次郎", workspace: "テスト株式会社" });
  await expect(page.getByTestId("sidebar")).toContainText("テスト株式会社");
  await page.getByTestId("nav-team-ENG-issues").click();
  await expect(page.getByTestId("issue-row").filter({ hasText: "Sen へようこそ" })).toBeVisible();
  await expect(page.getByTestId("issue-row")).toHaveCount(9);
});

test("ログアウトしてログインし直せる", async ({ page }) => {
  const { email } = await signupViaUi(page);
  await page.getByTestId("workspace-menu").click();
  await page.getByRole("button", { name: /ログアウト/ }).click();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill("wrong-password");
  await page.getByTestId("login-submit").click();
  await expect(page.locator(".form-error")).toContainText("正しくありません");
  await page.getByTestId("login-password").fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("app")).toBeVisible();
});

test("未ログインで画面を開くとログインに誘導される", async ({ page }) => {
  await page.goto("/some-workspace/my-issues");
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test("登録済みのメールアドレスでは登録できない", async ({ page, browser }) => {
  const email = uniqueEmail();
  await signupViaUi(page, { email });
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto("/signup");
  await p2.getByTestId("signup-name").fill("別の人");
  await p2.getByTestId("signup-email").fill(email);
  await p2.getByTestId("signup-password").fill(PASSWORD);
  await p2.getByTestId("signup-submit").click();
  await expect(p2.locator(".form-error")).toContainText("すでに登録");
  await ctx.close();
});
