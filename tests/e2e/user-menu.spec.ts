import { expect, test } from "@playwright/test";
import { signupViaUi, waitForSynced } from "./helpers";

test("ユーザーボタンに名前と同期の状態が出て、メニューから個人設定を開ける", async ({ page }) => {
  const { email, ws } = await signupViaUi(page, { name: "山田 花子" });
  await waitForSynced(page);
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子");
  await expect(page.getByTestId("user-menu").getByTestId("sync-status")).toContainText("同期済み");
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-menu-popover")).toContainText(email);
  await page.getByTestId("user-menu-profile").click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/settings/profile$`));
  await expect(page.getByTestId("profile-name")).toBeVisible();
  await expect(page.getByTestId("user-menu-popover")).toBeHidden();
});

test("テーマはメニューを閉じずに切り替わり、Esc で閉じるとボタンに戻る", async ({ page }) => {
  await signupViaUi(page);
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("user-menu-popover")).toBeVisible();
  await expect(page.getByTestId("user-menu-theme-dark")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("user-menu-theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("user-menu-popover")).toBeHidden();
  await expect(page.getByTestId("user-menu")).toBeFocused();
});

test("キーボードで開いて ↓ で次の項目へ移れる", async ({ page }) => {
  await signupViaUi(page);
  await page.getByTestId("user-menu").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-menu-profile")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("user-menu-ai")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("user-menu-logout")).toBeFocused();
});

test("ワークスペースのメニューには自分の項目を出さない", async ({ page }) => {
  await signupViaUi(page);
  await page.getByTestId("workspace-menu").click();
  await expect(page.locator(".menu-item", { hasText: "ワークスペースの設定" })).toBeVisible();
  await expect(page.locator(".menu-item", { hasText: "メンバーを招待" })).toBeVisible();
  await expect(page.locator(".menu-item", { hasText: "ログアウト" })).toHaveCount(0);
  await expect(page.locator(".menu-item", { hasText: "テーマ" })).toHaveCount(0);
});

test("スマートフォン幅では引き出しの一番下から個人設定を開ける", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { ws } = await signupViaUi(page);
  await page.getByRole("button", { name: "メニュー" }).click();
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-profile").click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/settings/profile$`));
  await expect(page.getByTestId("app")).not.toHaveClass(/sidebar-open/);
});
