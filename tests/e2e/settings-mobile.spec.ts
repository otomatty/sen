import { expect, test } from "@playwright/test";
import { signupViaUi } from "./helpers";

test("スマホ幅では設定の一覧からチームを作成して一覧に戻れる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { ws } = await signupViaUi(page);

  await page.getByRole("button", { name: "メニュー" }).click();
  await page.getByTestId("workspace-menu").click();
  await page.locator(".menu-item", { hasText: "設定" }).click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/settings$`));

  await expect(page.getByTestId("settings-nav-teams")).toBeVisible();
  await expect(page.locator(".settings-content")).toBeHidden();

  await page.getByTestId("settings-nav-teams").click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/settings/teams$`));
  await expect(page.locator(".settings-nav")).toBeHidden();
  await expect(page.getByTestId("settings-back")).toBeVisible();

  await page.getByLabel("チーム名").fill("デザイン");
  await page.getByLabel("識別子").fill("DES");
  await page.getByRole("button", { name: "チームを作成" }).click();
  await expect(page.locator(".settings-content .member-row").filter({ hasText: "デザイン" })).toBeVisible();

  await page.getByTestId("settings-back").click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/settings$`));
  await expect(page.getByTestId("settings-nav-team-DES")).toBeVisible();
  await page.getByTestId("settings-nav-team-DES").click();
  await expect(page.getByRole("heading", { name: "チーム：デザイン" })).toBeVisible();
});

test("PC 幅では今までどおり左メニューと全般が並んで表示される", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/settings`);

  await expect(page.locator(".settings-nav")).toBeVisible();
  await expect(page.getByRole("heading", { name: "ワークスペース" })).toBeVisible();
  await expect(page.getByTestId("settings-nav-workspace")).toHaveClass(/active/);
  await expect(page.getByTestId("settings-back")).toBeHidden();
});
