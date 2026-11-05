import { expect, test, type Page } from "@playwright/test";
import { signupViaUi, waitForSynced } from "./helpers";

/** ワークスペースのスナップショットが IndexedDB に保存されているか（キーは `${userId}:${urlKey}`） */
async function hasWorkspaceSnapshot(page: Page, key: string): Promise<boolean> {
  return page.evaluate(async (snapshotKey: string) => {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("sen-cache", 1);
        // アプリより先に DB を作ってしまっても、snapshots ストアが欠けないようにする
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("snapshots")) req.result.createObjectStore("snapshots");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const req = db.transaction("snapshots").objectStore("snapshots").getKey(snapshotKey);
          req.onsuccess = () => resolve(req.result !== undefined);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }, key);
}

test("一度開いたワークスペースに戻っても、あとから参加したワークスペースがメニューに残る", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "一つ目のワークスペース" });
  await waitForSynced(page);

  const me = await (await page.request.get("/api/me")).json();
  const userId = me.user.id as string;
  await expect.poll(() => hasWorkspaceSnapshot(page, `${userId}:${ws}`), { timeout: 10_000 }).toBe(true);

  const created = await page.request.post("/api/workspaces", {
    data: { name: "二つ目のワークスペース" },
    headers: { "x-sen-client": "1" },
  });
  expect(created.ok()).toBeTruthy();
  const workspaceKey = ((await created.json()) as { workspaceKey: string }).workspaceKey;
  expect(workspaceKey).toBeTruthy();

  await page.reload();
  await expect(page.getByTestId("app")).toBeVisible();

  await page.getByTestId("workspace-menu").click();
  const second = page.locator(".menu-item", { hasText: "二つ目のワークスペース に切り替え" });
  await expect(second).toBeVisible();
  await second.click();
  await expect(page).toHaveURL(new RegExp(`/${workspaceKey}/`));
  await expect(page.getByTestId("app")).toBeVisible();
  // 切り替え先の画面が出てからメニューを開く（読み込み中に開くと閉じてしまう）
  await expect(page.getByTestId("workspace-menu")).toContainText("二つ目のワークスペース");

  await page.getByTestId("workspace-menu").click();
  const first = page.locator(".menu-item", { hasText: "一つ目のワークスペース に切り替え" });
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(new RegExp(`/${ws}/`));
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("workspace-menu")).toContainText("一つ目のワークスペース");

  await page.getByTestId("workspace-menu").click();
  await expect(page.locator(".menu-item", { hasText: "二つ目のワークスペース に切り替え" })).toBeVisible();
});

test("画面を開いたまま別の場所で参加したワークスペースも、メニューを開けば出る", async ({ page }) => {
  await signupViaUi(page, { workspace: "一つ目のワークスペース" });
  await waitForSynced(page);

  const created = await page.request.post("/api/workspaces", {
    data: { name: "三つ目のワークスペース" },
    headers: { "x-sen-client": "1" },
  });
  expect(created.ok()).toBeTruthy();

  await page.getByTestId("workspace-menu").click();
  await expect(page.locator(".menu-item", { hasText: "三つ目のワークスペース に切り替え" })).toBeVisible();
});
