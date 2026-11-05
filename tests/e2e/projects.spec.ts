import { expect, test } from "@playwright/test";
import { seedDemo, signupViaUi } from "./helpers";

test.describe("プロジェクト一覧", () => {
  let ws: string;

  test.beforeEach(async ({ page }) => {
    ({ ws } = await signupViaUi(page));
    await seedDemo(page.request, ws);
  });

  test("進行中が既定で、タブは URL に残り、空のタブは他の件数を案内する", async ({ page }) => {
    await page.goto(`/${ws}/team/ENG/projects`);
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${ws}/team/ENG/projects$`));

    const tabs = page.getByRole("tablist");
    await expect(tabs.getByRole("tab")).toHaveCount(3);
    await expect(tabs.getByRole("tab", { name: "すべて" })).toHaveCount(0);

    const active = page.getByTestId("projects-tab-active");
    const planned = page.getByTestId("projects-tab-planned");
    const done = page.getByTestId("projects-tab-done");
    await expect(active).toHaveClass(/active/);
    await expect(active).toHaveAttribute("aria-selected", "true");
    await expect(planned).toHaveAttribute("aria-selected", "false");
    await expect(active.locator(".tab-count")).toHaveText("3");
    await expect(planned.locator(".tab-count")).toHaveText("1");
    await expect(done.locator(".tab-count")).toHaveText("0");

    const rows = page.getByTestId("project-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "モバイルアプリ v2.0" })).toBeVisible();
    await expect(rows.filter({ hasText: "決済基盤の刷新" })).toBeVisible();
    await expect(rows.filter({ hasText: "オンボーディング体験の改善" })).toBeVisible();
    await expect(rows.filter({ hasText: "パフォーマンス改善 Q4" })).toHaveCount(0);

    await planned.click();
    await expect(page).toHaveURL(new RegExp(`/${ws}/team/ENG/projects\\?status=planned$`));
    await expect(planned).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-row")).toHaveCount(1);
    await expect(page.getByTestId("project-row")).toContainText("パフォーマンス改善 Q4");

    await page.getByTestId("project-row").click();
    await expect(page.getByTestId("project-page")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page).toHaveURL(/status=planned/);
    await expect(planned).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-row")).toContainText("パフォーマンス改善 Q4");

    await done.click();
    await expect(page).toHaveURL(/status=done/);
    const empty = page.getByTestId("projects-empty");
    await expect(empty).toContainText("完了したプロジェクトはありません");
    await expect(empty).toContainText("進行中に 3 件、計画中に 1 件あります");
    await expect(empty.getByRole("button", { name: "プロジェクトを作成" })).toBeVisible();
    await empty.getByRole("button", { name: "計画中", exact: true }).click();
    await expect(page).toHaveURL(/status=planned/);
    await expect(planned).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-row")).toContainText("パフォーマンス改善 Q4");
  });

  test("不正な status では進行中になる", async ({ page }) => {
    await page.goto(`/${ws}/projects?status=xxx`);
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(page.getByTestId("projects-tab-active")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("projects-tab-active")).toHaveClass(/active/);
    await expect(page.getByRole("tab", { name: "すべて" })).toHaveCount(0);
    await expect(page.getByTestId("project-row").filter({ hasText: "モバイルアプリ v2.0" })).toBeVisible();
    await expect(page.getByTestId("project-row").filter({ hasText: "パフォーマンス改善 Q4" })).toHaveCount(0);
    await expect(page.getByTestId("project-row")).toHaveCount(4);
  });

  test("詳細のパンくずは、そのプロジェクトがあるタブの一覧に戻る", async ({ page }) => {
    await page.goto(`/${ws}/team/ENG/projects?status=planned`);
    await page.getByTestId("project-row").filter({ hasText: "パフォーマンス改善 Q4" }).click();
    await expect(page.getByTestId("project-page")).toBeVisible();

    await page.getByTestId("project-page").locator("a.crumb").click();
    await expect(page).toHaveURL(new RegExp(`/${ws}/projects\\?status=planned$`));
    await expect(page.getByTestId("projects-tab-planned")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-row").filter({ hasText: "パフォーマンス改善 Q4" })).toBeVisible();

    await page.getByTestId("projects-tab-active").click();
    await page.getByTestId("project-row").filter({ hasText: "モバイルアプリ v2.0" }).click();
    await expect(page.getByTestId("project-page")).toBeVisible();

    await page.getByTestId("project-page").locator("a.crumb").click();
    await expect(page).toHaveURL(new RegExp(`/${ws}/projects$`));
    await expect(page.getByTestId("projects-tab-active")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("project-row").filter({ hasText: "モバイルアプリ v2.0" })).toBeVisible();
  });
});
