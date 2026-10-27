import { expect, test } from "@playwright/test";
import { row, seedDemo, signupViaUi, waitForSynced } from "./helpers";

test.describe("課題の操作", () => {
  test.beforeEach(async ({ page }) => {
    const { ws } = await signupViaUi(page);
    await seedDemo(page.request, ws);
    await page.goto(`/${ws}/team/ENG/all`);
    await expect(page.getByTestId("issue-list")).toBeVisible();
  });

  test("C キーで課題を作成し、サーバーに保存される", async ({ page }) => {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("c");
    const modal = page.getByTestId("create-issue-modal");
    await expect(modal).toBeVisible();
    await page.getByTestId("create-title").fill("E2E で作った課題");
    await page.getByTestId("create-priority").click();
    await page.getByTestId("picker-priority").getByRole("option", { name: /^高/ }).click();
    await page.keyboard.press("Control+Enter");
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("issue-row").filter({ hasText: "E2E で作った課題" })).toBeVisible();
    await waitForSynced(page);
    // 再読み込みしても残っている＝サーバーに保存されている
    await page.reload();
    await expect(page.getByTestId("issue-row").filter({ hasText: "E2E で作った課題" })).toBeVisible();
  });

  test("キーボードでフォーカスしてステータスと優先度を変更できる", async ({ page }) => {
    await row(page, "ENG-7").hover();
    await page.keyboard.press("s");
    await expect(page.getByTestId("picker-status")).toBeVisible();
    await page.keyboard.type("完了");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-testid=issue-group][data-group='完了']").locator("[data-identifier='ENG-7']")).toBeVisible();
    await page.keyboard.press("p");
    await page.keyboard.press("1");
    await waitForSynced(page);
    await page.reload();
    await row(page, "ENG-7").click();
    await expect(page.getByTestId("prop-status")).toContainText("完了");
    await expect(page.getByTestId("prop-priority")).toContainText("緊急");
  });

  test("X で複数選択してまとめて担当者を変更し、元に戻せる", async ({ page }) => {
    await row(page, "ENG-16").hover();
    await page.keyboard.press("x");
    await page.keyboard.press("j");
    await page.keyboard.press("x");
    await expect(page.getByTestId("selection-bar")).toContainText("2件を選択中");
    await page.keyboard.press("a");
    await page.getByTestId("picker-assignee").getByRole("option", { name: /伊藤/ }).click();
    await expect(row(page, "ENG-16").locator(".avatar[title='伊藤 さくら']")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("selection-bar")).toBeHidden();
    await page.keyboard.press("Control+z");
    await expect(row(page, "ENG-16").locator(".avatar[title='伊藤 さくら']")).toBeHidden();
  });

  test("フィルターで担当者を絞り込める", async ({ page }) => {
    await page.getByTestId("filter-button").click();
    await page.locator(".menu-item", { hasText: "担当者" }).click();
    await page.getByTestId("filter-picker-assignee").getByRole("option", { name: /自分/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("filter-chip-assignee")).toBeVisible();
    const rows = page.getByTestId("issue-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(rows.nth(i).locator(".row-assignee .avatar")).toHaveAttribute("title", "テスト 太郎");
  });

  test("ボードでカードをドラッグするとステータスが変わる", async ({ page }) => {
    await page.getByTestId("layout-board").click();
    const card = page.locator("[data-testid=board-card][data-identifier='ENG-9']");
    const target = page.locator("[data-testid=board-column][data-group='レビュー中'] [data-testid=board-card]").first();
    const from = (await card.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 30, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + 10, { steps: 15 });
    await page.mouse.up();
    await expect(page.locator("[data-testid=board-column][data-group='レビュー中']").locator("[data-identifier='ENG-9']")).toBeVisible();
    await waitForSynced(page);
  });

  test("一覧で行をドラッグすると、別のステータスに移せる", async ({ page }) => {
    const src = row(page, "ENG-7");
    const target = page.locator("[data-testid=issue-group][data-group='進行中'] [data-testid=issue-row]").first();
    const from = (await src.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + 200, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 210, from.y + from.height / 2 - 20, { steps: 4 });
    await page.mouse.move(to.x + 200, to.y + 8, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator("[data-testid=issue-group][data-group='進行中']").locator("[data-identifier='ENG-7']")).toBeVisible();
    await waitForSynced(page);
  });

  test("コマンドパレットから画面を移動できる", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.getByTestId("palette-input").fill("受信トレイ");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
  });

  test("検索でタイトルと ID から課題が見つかる", async ({ page }) => {
    await page.keyboard.press("/");
    await page.getByTestId("search-input").fill("ENG-12");
    await expect(page.getByTestId("issue-row")).toHaveCount(1);
    await page.getByTestId("search-input").fill("決済");
    await expect(page.getByTestId("issue-row").first()).toContainText("決済");
  });
});
