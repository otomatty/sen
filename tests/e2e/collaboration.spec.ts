import { expect, test } from "@playwright/test";
import { PASSWORD, dismissWelcome, signupViaUi, uniqueEmail, waitForSynced } from "./helpers";

test("招待リンクで参加したメンバーに、変更がリアルタイムで届く", async ({ page, browser }) => {
  // 1人目: ワークスペースを作る
  const { ws } = await signupViaUi(page, { name: "管理 花子" });
  await page.goto(`/${ws}/settings/members`);
  const invite = await page.getByTestId("invite-link").inputValue();
  const code = invite.split("/invite/")[1];

  // 2人目: 招待リンクから参加
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`/invite/${code}`);
  await p2.getByTestId("signup-name").fill("参加 太郎");
  await p2.getByTestId("signup-email").fill(uniqueEmail("member"));
  await p2.getByTestId("signup-password").fill(PASSWORD);
  await p2.getByTestId("signup-submit").click();
  await expect(p2.getByTestId("app")).toBeVisible();
  await dismissWelcome(p2);
  await expect(p2).toHaveURL(new RegExp(`/${ws}/`));
  await p2.goto(`/${ws}/team/ENG/all`);
  await expect(p2.getByTestId("sync-status")).toHaveAttribute("data-realtime", "on", { timeout: 15_000 });

  // 1人目が課題のタイトルを変えると、2人目の画面に反映される
  await page.goto(`/${ws}/issue/ENG-1`);
  const title = page.getByTestId("issue-title");
  await title.fill("リアルタイム同期のテスト");
  await title.press("Enter");
  await expect(p2.getByTestId("issue-row").filter({ hasText: "リアルタイム同期のテスト" })).toBeVisible({ timeout: 10_000 });

  // 1人目が2人目に割り当てると、2人目の受信トレイに通知が届く
  await page.getByTestId("prop-assignee").click();
  await page.getByTestId("picker-assignee").getByRole("option", { name: /参加 太郎/ }).click();
  await p2.getByTestId("nav-inbox").click();
  await expect(p2.getByTestId("inbox-item").first()).toContainText("あなたを担当者にしました", { timeout: 10_000 });
  await ctx2.close();
});

test("オフラインの間の変更は保持され、復帰後に送信される", async ({ page, context }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/issue/ENG-2`);
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await waitForSynced(page);
  await context.setOffline(true);
  const title = page.getByTestId("issue-title");
  await title.fill("オフラインで編集");
  await title.press("Enter");
  await expect(page.getByTestId("sync-status")).toContainText("オフライン", { timeout: 10_000 });
  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toContainText("同期済み", { timeout: 40_000 });
  await page.reload();
  await expect(page.getByTestId("issue-title")).toHaveValue("オフラインで編集");
});

test("一度開いた後は、オフラインでも起動して手元のデータを表示できる", async ({ page, context }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/team/ENG/all`);
  await expect(page.getByTestId("issue-row")).toHaveCount(9);
  // サービスワーカーがアプリ本体を保存し、データのキャッシュが書き込まれるのを待つ
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByTestId("issue-row")).toHaveCount(9);
  await page.waitForTimeout(2500);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("issue-row").filter({ hasText: "Sen へようこそ" })).toBeVisible();
  await expect(page.getByTestId("sync-status")).toContainText("オフライン", { timeout: 20_000 });
  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toContainText("同期済み", { timeout: 40_000 });
});
