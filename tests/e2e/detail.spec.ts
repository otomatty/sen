import { expect, test } from "@playwright/test";
import { row, seedDemo, signupViaUi, waitForSynced } from "./helpers";

test("課題の詳細でタイトル・説明・サブ課題・コメントを編集できる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/team/ENG/all`);
  await row(page, "ENG-15").click();
  const detail = page.getByTestId("issue-detail");
  await expect(detail).toBeVisible();

  // タイトル
  const title = page.getByTestId("issue-title");
  await title.fill("迷惑メール判定の原因を調べる");
  await title.press("Enter");

  // 説明（Markdown の見出し記法）
  await page.getByTestId("issue-description").click();
  await page.keyboard.type("## 調査メモ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("SPF を確認する");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("issue-description").locator("h2")).toHaveText("調査メモ");

  // サブ課題
  await page.getByTestId("add-sub-issue").click();
  await page.getByTestId("sub-issue-input").fill("DKIM を設定する");
  await page.getByTestId("sub-issue-input").press("Enter");
  await expect(page.getByTestId("sub-issues")).toContainText("DKIM を設定する");
  await page.getByTestId("sub-issue-input").press("Escape");

  // メンション付きコメント
  await page.getByTestId("comment-input").click();
  await page.keyboard.type("@佐藤");
  await expect(page.getByTestId("mention-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("確認お願いします");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("comment").last()).toContainText("@佐藤 花子 確認お願いします");

  // 履歴にタイトル変更が残る
  await expect(page.getByTestId("activity")).toContainText("タイトルを");
  await waitForSynced(page);

  // 再読み込み後も保存されている
  await page.reload();
  await expect(page.getByTestId("issue-title")).toHaveValue("迷惑メール判定の原因を調べる");
  await expect(page.getByTestId("issue-description").locator("h2")).toHaveText("調査メモ");
  await expect(page.getByTestId("comment").last()).toContainText("確認お願いします");
  await expect(page.getByTestId("sub-issues")).toContainText("DKIM を設定する");
});

test("プロパティを変更すると履歴に残り、削除と復元ができる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/issue/ENG-7`);
  await page.getByTestId("prop-labels").click();
  await page.getByTestId("picker-labels").getByRole("option", { name: /バグ/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("activity")).toContainText("ラベル");
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByTestId("toast").filter({ hasText: "削除しました" })).toBeVisible();
  await page.getByTestId("toast").getByRole("button", { name: "元に戻す" }).click();
  await page.goto(`/${ws}/team/ENG/all`);
  await expect(row(page, "ENG-7")).toBeVisible();
});

test("課題どうしの関係（ブロック・重複）を設定して外せる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/issue/ENG-15`);
  await expect(page.getByTestId("issue-detail")).toBeVisible();

  // M → B で「ブロックされている」課題を指定
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("m");
  await page.keyboard.press("b");
  await expect(page.getByTestId("picker-relation")).toBeVisible();
  await page.keyboard.type("二重送信");
  await page.keyboard.press("Enter");
  const rel = page.locator("[data-testid=relation-row][data-kind=blockedBy][data-identifier='ENG-2']");
  await expect(rel).toBeVisible();
  await expect(page.getByTestId("activity")).toContainText("ブロックされている");

  // 一覧ではブロック中の印が付く
  await page.goto(`/${ws}/team/ENG/all`);
  await expect(row(page, "ENG-15").getByTestId("blocked-chip")).toBeVisible();

  // 相手の課題からは「ブロックしている」として見える。そこから外す
  await page.goto(`/${ws}/issue/ENG-2`);
  const back = page.locator("[data-testid=relation-row][data-kind=blocks][data-identifier='ENG-15']");
  await expect(back).toBeVisible();
  await back.hover();
  await back.getByRole("button", { name: "関係を外す" }).click();
  await expect(back).toBeHidden();
  await waitForSynced(page);
  await page.reload();
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await expect(back).toBeHidden();

  // M → M で重複にすると、キャンセル（重複）に移る
  await page.goto(`/${ws}/issue/ENG-14`);
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("m");
  await page.keyboard.press("m");
  await page.keyboard.type("ENG-13");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=relation-row][data-kind=duplicate]")).toHaveCount(1);
  await expect(page.getByTestId("prop-status")).toContainText("重複");
});
