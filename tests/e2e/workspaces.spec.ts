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

test("初めて作るワークスペースにだけサンプルが入り、2 つ目以降はチーム「デフォルト」とラベルだけになる", async ({ page }) => {
  const { ws } = await signupViaUi(page, { workspace: "はじめてのワークスペース" });

  const firstRes = await page.request.get(`/api/bootstrap?ws=${ws}`);
  expect(firstRes.ok()).toBeTruthy();
  const first = await firstRes.json();
  const labelNames = (labels: { name: string }[]) => labels.map((label) => label.name).sort();
  expect(first.teams).toHaveLength(1);
  expect(first.teams[0]).toMatchObject({ name: "デフォルト", key: "DEF" });
  expect(first.issues).toHaveLength(9);
  expect(first.projects).toHaveLength(1);
  expect(first.cycles).toHaveLength(2);
  expect(labelNames(first.labels)).toEqual(["バグ", "機能", "改善"].sort());

  const created = await page.request.post("/api/workspaces", {
    data: { name: "ふたつ目のワークスペース" },
    headers: { "x-sen-client": "1" },
  });
  expect(created.ok()).toBeTruthy();
  const key = ((await created.json()) as { workspaceKey: string }).workspaceKey;

  const secondRes = await page.request.get(`/api/bootstrap?ws=${key}`);
  expect(secondRes.ok()).toBeTruthy();
  const second = await secondRes.json();
  expect(second.teams).toHaveLength(1);
  expect(second.teams[0]).toMatchObject({ name: "デフォルト", key: "DEF" });
  expect(second.issues).toHaveLength(0);
  expect(second.projects).toHaveLength(0);
  expect(second.cycles).toHaveLength(0);
  expect(labelNames(second.labels)).toEqual(["バグ", "機能", "改善"].sort());
});

test("最初に開くワークスペースを選ぶと、最後に開いたワークスペースより優先して開く", async ({ page }) => {
  const { ws: ws1 } = await signupViaUi(page, { workspace: "ワークスペース1" });
  await waitForSynced(page);

  const created = await page.request.post("/api/workspaces", {
    data: { name: "ワークスペース2" },
    headers: { "x-sen-client": "1" },
  });
  expect(created.ok()).toBeTruthy();
  const ws2 = ((await created.json()) as { workspaceKey: string }).workspaceKey;

  const before = (await (await page.request.get("/api/me")).json()) as { workspaces: { id: string; urlKey: string }[] };
  const id1 = before.workspaces.find((w) => w.urlKey === ws1)?.id;
  expect(id1).toBeTruthy();

  await page.goto(`/${ws2}/settings/profile`);
  await expect(page.getByTestId("default-workspace")).toBeVisible();
  await page.getByTestId("default-workspace").selectOption(id1!);
  await expect
    .poll(async () => ((await (await page.request.get("/api/me")).json()) as { defaultWorkspaceId: string | null }).defaultWorkspaceId)
    .toBe(id1);

  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/${ws1}/`));

  await page.goto(`/${ws2}/settings/profile`);
  await expect(page.getByTestId("default-workspace")).toBeVisible();
  await page.getByTestId("default-workspace").selectOption({ label: "最後に開いたワークスペース" });
  await expect
    .poll(async () => ((await (await page.request.get("/api/me")).json()) as { defaultWorkspaceId: string | null }).defaultWorkspaceId)
    .toBeNull();

  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`/${ws2}/`));
});

test("設定を開いた直後の取り直しが遅れても、選んだ最初に開くワークスペースが元に戻らない", async ({ page }) => {
  const { ws: ws1 } = await signupViaUi(page, { workspace: "ワークスペース1" });
  await waitForSynced(page);

  const created = await page.request.post("/api/workspaces", {
    data: { name: "ワークスペース2" },
    headers: { "x-sen-client": "1" },
  });
  expect(created.ok()).toBeTruthy();
  const ws2 = ((await created.json()) as { workspaceKey: string }).workspaceKey;

  const before = (await (await page.request.get("/api/me")).json()) as { workspaces: { id: string; urlKey: string }[] };
  const id1 = before.workspaces.find((w) => w.urlKey === ws1)?.id;
  expect(id1).toBeTruthy();

  // GET はすぐサーバーへ取りにいき、保存前の応答を 1.5 秒遅れて届ける。
  const gets: { fetched: boolean; fulfilled: boolean }[] = [];
  await page.route("**/api/me", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const slot = { fetched: false, fulfilled: false };
    gets.push(slot);
    const response = await route.fetch();
    slot.fetched = true;
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({ response });
    slot.fulfilled = true;
  });

  await page.goto(`/${ws2}/settings/profile`);
  await expect(page.getByTestId("default-workspace")).toBeVisible();
  // select が出るのは loadSession のあと。設定画面の取り直しが保存前の応答を持って遅れているうちに選ぶ。
  await expect.poll(() => gets.some((g) => g.fetched && !g.fulfilled)).toBe(true);
  await page.getByTestId("default-workspace").selectOption(id1!);
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("default-workspace")).toHaveValue(id1!);
});

test("参加していないワークスペースは最初に開くワークスペースにできない", async ({ page, browser }) => {
  await signupViaUi(page, { workspace: "自分のワークスペース" });

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  const { ws: otherKey } = await signupViaUi(p2, { name: "別の 人", workspace: "他人のワークスペース" });
  const me2 = (await (await p2.request.get("/api/me")).json()) as { workspaces: { id: string; urlKey: string }[] };
  const otherId = me2.workspaces.find((w) => w.urlKey === otherKey)?.id;
  expect(otherId).toBeTruthy();

  const foreign = await page.request.post("/api/me/default-workspace", {
    data: { workspaceId: otherId },
    headers: { "x-sen-client": "1" },
  });
  expect(foreign.status()).toBe(404);

  const me = (await (await page.request.get("/api/me")).json()) as { defaultWorkspaceId: string | null };
  expect(me.defaultWorkspaceId).toBeNull();

  const missing = await page.request.post("/api/me/default-workspace", {
    data: { workspaceId: "does-not-exist" },
    headers: { "x-sen-client": "1" },
  });
  expect(missing.status()).toBe(404);

  const badType = await page.request.post("/api/me/default-workspace", {
    data: { workspaceId: 123 },
    headers: { "x-sen-client": "1" },
  });
  expect(badType.status()).toBe(400);

  const noHeader = await page.request.post("/api/me/default-workspace", {
    data: { workspaceId: null },
  });
  expect(noHeader.status()).toBe(403);
  await ctx.close();
});
