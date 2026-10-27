import { expect, test } from "@playwright/test";
import { seedDemo, signupViaUi } from "./helpers";

test("受信トレイは課題ごとにまとまり、U で未読に戻した通知は未読のまま残る", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/inbox`);
  const items = page.getByTestId("inbox-item");
  await expect(items.first()).toBeVisible();

  // 同じ課題への通知は 1 行にまとまり、件数が表示される
  const ids = await items.locator(".row-id").allTextContents();
  expect(new Set(ids).size).toBe(ids.length);
  await expect(page.locator(".inbox-count").first()).toBeVisible();

  // 開くと既読になり、U で未読に戻すとそのまま
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("j");
  const active = page.locator(".inbox-item.active");
  await expect(active).not.toHaveClass(/unread/);
  await page.keyboard.press("u");
  await expect(active).toHaveClass(/unread/);
  await page.waitForTimeout(1000);
  await expect(active).toHaveClass(/unread/);

  // Backspace で片付けると一覧から消える
  const before = await items.count();
  await page.keyboard.press("Backspace");
  await expect(items).toHaveCount(before - 1);
});

test("通知がないときは、通知が届く条件と次の操作を案内する", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/inbox`);

  // メンバーが自分だけなら、招待をすすめる。選ぶ通知がないので右側の「通知を選択」は出さない
  await expect(page.getByTestId("inbox-guide")).toBeVisible();
  await expect(page.getByTestId("inbox-invite")).toBeVisible();
  await expect(page.getByText("通知を選択してください")).toBeHidden();
  await expect(page.getByTestId("inbox-mark-all")).toBeDisabled();

  await page.getByTestId("inbox-invite").click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/settings/workspace$`));
  await expect(page.getByTestId("invite-link")).toBeVisible();
});

test("未読のみ表示で何もなければ、すべての通知の表示に戻せる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  await page.goto(`/${ws}/inbox`);
  const items = page.getByTestId("inbox-item");
  await expect(items.first()).toBeVisible();
  const total = await items.count();

  await page.getByTestId("inbox-mark-all").click();
  await expect(page.getByTestId("inbox-mark-all")).toBeDisabled();
  await page.getByTestId("inbox-unread-only").click();
  await expect(items).toHaveCount(0);
  await expect(page.getByText("未読の通知はありません")).toBeVisible();
  // 通知はあるので、届く条件の案内は出さない
  await expect(page.getByTestId("inbox-guide")).toBeHidden();

  await page.getByTestId("inbox-show-all").click();
  await expect(items).toHaveCount(total);
});
