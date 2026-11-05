import { devices, expect, test, type Page } from "@playwright/test";
import { seedDemo, signupViaUi, waitForSynced } from "./helpers";

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

  test("ドラッグで表示順を並び替えられ、再読み込み後も保たれる", async ({ page }) => {
    await page.goto(`/${ws}/projects`);
    await expect(page.getByTestId("projects-page")).toBeVisible();
    const names = page.locator("[data-testid=project-row] .cell-name b");
    await expect(names).toHaveCount(4);
    const before = await names.allTextContents();

    const rows = page.getByTestId("project-row");
    const from = (await rows.last().boundingBox())!;
    const to = (await rows.first().boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 30, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + 10, { steps: 15 });
    await page.mouse.up();

    const movedFirst = [before[before.length - 1], ...before.slice(0, -1)];
    await expect(names).toHaveText(movedFirst);
    await expect(page).toHaveURL(new RegExp(`/${ws}/projects$`));
    await expect(page.getByTestId("project-page")).toHaveCount(0);

    await waitForSynced(page);
    await page.reload();
    await expect(page.getByTestId("projects-page")).toBeVisible();
    await expect(names).toHaveText(movedFirst);

    const fromTop = (await rows.first().boundingBox())!;
    const toBottom = (await rows.last().boundingBox())!;
    await page.mouse.move(fromTop.x + fromTop.width / 2, fromTop.y + fromTop.height / 2);
    await page.mouse.down();
    await page.mouse.move(fromTop.x + 30, fromTop.y + 30, { steps: 5 });
    await page.mouse.move(toBottom.x + toBottom.width / 2, toBottom.y + toBottom.height - 10, { steps: 15 });
    await page.mouse.up();

    await expect(names).toHaveText([...movedFirst.slice(1), movedFirst[0]]);
    await expect(page).toHaveURL(new RegExp(`/${ws}/projects$`));
  });
});

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  if (holdMs) await page.waitForTimeout(holdMs);
  const steps = 15;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.describe("プロジェクト一覧（スマホ）", () => {
  const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 7"];
  test.use(pixel);

  let ws: string;

  test.beforeEach(async ({ page }) => {
    ({ ws } = await signupViaUi(page));
    await seedDemo(page.request, ws);
  });

  test("長押ししてから指で動かすと並び替えられる", async ({ page }) => {
    await page.goto(`/${ws}/projects`);
    await expect(page.getByTestId("projects-page")).toBeVisible();
    const names = page.locator("[data-testid=project-row] .cell-name b");
    await expect(names).toHaveCount(4);
    const before = await names.allTextContents();

    const rows = page.getByTestId("project-row");
    const from = (await rows.last().boundingBox())!;
    const to = (await rows.first().boundingBox())!;
    await touchDrag(
      page,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + 8 },
      400,
    );

    const movedFirst = [before[before.length - 1], ...before.slice(0, -1)];
    await expect(names).toHaveText(movedFirst);
    await expect(page).toHaveURL(new RegExp(`/${ws}/projects$`));
    await expect(page.getByTestId("project-page")).toHaveCount(0);
    await waitForSynced(page);
  });

  test("長押しせずに指を動かしたときは並び替えにならない", async ({ page }) => {
    await page.goto(`/${ws}/projects`);
    await expect(page.getByTestId("projects-page")).toBeVisible();
    const names = page.locator("[data-testid=project-row] .cell-name b");
    await expect(names).toHaveCount(4);
    const before = await names.allTextContents();

    const rows = page.getByTestId("project-row");
    const from = (await rows.last().boundingBox())!;
    const to = (await rows.first().boundingBox())!;
    await touchDrag(
      page,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + 8 },
      0,
    );
    await page.waitForTimeout(500);
    await expect(names).toHaveText(before);
  });
});
