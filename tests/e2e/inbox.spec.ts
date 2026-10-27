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
