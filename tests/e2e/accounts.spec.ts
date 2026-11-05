import { expect, test, type Page } from "@playwright/test";
import { devSignIn, dismissWelcome, signupViaUi, waitForSynced } from "./helpers";

/** 山田 花子（花子の会社）でログインしたあと、同じブラウザで佐藤 次郎（次郎の会社）を追加する。追加した次郎が今のアカウントになる */
async function signInTwoAccounts(page: Page) {
  const hanako = await signupViaUi(page, { name: "山田 花子", workspace: "花子の会社" });
  // 開発用のログインは Cookie を共有するので、ブラウザに 2 つ目のアカウントが記録される
  const jiroEmail = await devSignIn(page, { name: "佐藤 次郎" });
  // 開いていた画面が別アカウントへの切り替わりを検知して同じ URL へ移ると、この移動は中断される
  await page.goto("/").catch((err: unknown) => {
    if (!String(err).includes("ERR_ABORTED")) throw err;
  });
  await expect(page.getByTestId("new-workspace-form")).toBeVisible();
  await page.getByTestId("new-workspace-name").fill("次郎の会社");
  await page.getByTestId("new-workspace-submit").click();
  await expect(page.getByTestId("app")).toBeVisible();
  await dismissWelcome(page);
  const jiroWs = new URL(page.url()).pathname.split("/")[1];
  return { hanako, jiro: { email: jiroEmail, ws: jiroWs } };
}

const accountRows = (page: Page) => page.locator('[data-testid^="user-menu-account-"]');

test("2 つ目のアカウントを追加すると、メニューから切り替えられる", async ({ page }) => {
  const { hanako } = await signInTwoAccounts(page);
  await expect(page.getByTestId("user-menu")).toContainText("佐藤 次郎");
  await page.getByTestId("user-menu").click();
  await expect(accountRows(page)).toHaveCount(2);
  await expect(page.locator('[data-testid^="user-menu-account-"][aria-checked="true"]')).toContainText("佐藤 次郎");
  await accountRows(page).filter({ hasText: "山田 花子" }).click();
  await expect(page).toHaveURL(new RegExp(`/${hanako.ws}/`));
  await expect(page.getByTestId("sidebar")).toContainText("花子の会社");
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子");
  await page.getByTestId("user-menu").click();
  await expect(accountRows(page).filter({ hasText: "山田 花子" })).toHaveAttribute("aria-checked", "true");
});

test("このアカウントからログアウトすると、残ったアカウントに切り替わる", async ({ page }) => {
  const { hanako } = await signInTwoAccounts(page);
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-logout-current").click();
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子");
  await expect(page).toHaveURL(new RegExp(`/${hanako.ws}/`));
  await page.getByTestId("user-menu").click();
  await expect(page.getByTestId("user-menu-logout")).toBeVisible();
  await expect(accountRows(page)).toHaveCount(0);
  await expect(page.getByTestId("user-menu-logout-all")).toHaveCount(0);
});

test("すべてのアカウントからログアウトすると、ログイン画面になる", async ({ page }) => {
  await signInTwoAccounts(page);
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-logout-all").click();
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.goto("/");
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test("別のアカウントを追加すると Google のアカウント選択へ移り、やめると元のアカウントのまま", async ({ page, context }) => {
  await signupViaUi(page, { name: "山田 花子" });
  let authUrl: URL | null = null;
  // 本物の Google には行かず、利用者が「キャンセル」を押したことにしてアプリへ戻す
  await context.route("https://accounts.google.com/**", (route) => {
    authUrl = new URL(route.request().url());
    const back = new URL(authUrl.searchParams.get("redirect_uri")!);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", authUrl.searchParams.get("state")!);
    return route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await page.getByTestId("user-menu").click();
  await page.getByTestId("user-menu-add-account").click();
  await expect.poll(() => authUrl?.searchParams.get("prompt")).toBe("select_account");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子");
});

test("オフラインで未送信の変更があるあいだは、切り替えと追加ができない", async ({ page, context }) => {
  const { jiro } = await signInTwoAccounts(page);
  await waitForSynced(page);
  await page.goto(`/${jiro.ws}/team/DEF/all`);
  await expect(page.getByTestId("app")).toBeVisible();
  if ((await page.getByTestId("issue-row").count()) === 0) {
    await page.getByTestId("sidebar-create").click();
    await page.getByTestId("create-title").fill("オフラインで確認する課題");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("issue-row").first()).toBeVisible();
  }
  await page.getByTestId("issue-row").first().click();
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await context.setOffline(true);
  const title = page.getByTestId("issue-title");
  await title.fill("オフラインで編集");
  await title.press("Enter");
  await expect(page.getByTestId("sync-status")).toContainText("オフライン", { timeout: 10_000 });
  await page.getByTestId("user-menu").click();
  await expect(accountRows(page).filter({ hasText: "山田 花子" })).toBeDisabled();
  await expect(page.getByTestId("user-menu-add-account")).toBeDisabled();
  await expect(page.getByTestId("user-menu-popover")).toContainText("オフラインのあいだは切り替えられません");
  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toContainText("同期済み", { timeout: 40_000 });
});

test("別のタブで切り替えると、開いていたタブも切り替わる", async ({ page }) => {
  await signInTwoAccounts(page);
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByTestId("user-menu")).toContainText("佐藤 次郎");
  // 新しいタブはウェルカムをまだ見ていないので、メニューを押す前に閉じる
  await dismissWelcome(other);
  await other.getByTestId("user-menu").click();
  await accountRows(other).filter({ hasText: "山田 花子" }).click();
  await expect(other.getByTestId("user-menu")).toContainText("山田 花子");
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子", { timeout: 15_000 });
});

test("画面と違うアカウントからのリクエストは止める", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const blocked = await page.request.get(`/api/sync?ws=${ws}&after=0`, { headers: { "x-sen-user": "someone-else" } });
  expect(blocked.status()).toBe(409);
  expect(((await blocked.json()) as { code?: string }).code).toBe("account-switched");
  const ok = await page.request.get(`/api/sync?ws=${ws}&after=0`);
  expect(ok.status()).toBe(200);
});

test("画面と違うアカウントからの『このアカウントからログアウト』は止める", async ({ page }) => {
  await signupViaUi(page);
  const blocked = await page.request.post("/api/accounts/sign-out", {
    data: {},
    headers: { "x-sen-client": "1", "x-sen-user": "someone-else" },
  });
  expect(blocked.status()).toBe(409);
  expect(((await blocked.json()) as { code?: string }).code).toBe("account-switched");
  const me = await page.request.get("/api/me");
  expect(((await me.json()) as { user: unknown }).user).not.toBeNull();
});

test("Google から戻ってきたように別のアカウントで開き直すと、ほかのタブも切り替わる", async ({ page }) => {
  await signInTwoAccounts(page);
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByTestId("user-menu")).toContainText("佐藤 次郎");
  // 通知の直後に読み込み直すと、ワークスペースを作る前に作成画面で止まる。メニューが出るまで /api/me を待つ
  let releaseMe = () => {};
  const meReady = new Promise<void>((resolve) => {
    releaseMe = resolve;
  });
  await other.route("**/api/me", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/me") {
      await route.continue();
      return;
    }
    await meReady;
    await route.continue();
  });
  // 定期的な差分の取得で 409 になって読み込み直す道をふさぎ、知らせだけで切り替わることを確かめる
  await other.route("**/api/sync**", () => {});
  try {
    await devSignIn(page, { name: "鈴木 三郎" });
    await page.goto("/").catch((err: unknown) => {
      if (!String(err).includes("ERR_ABORTED")) throw err;
    });
    await expect(page.getByTestId("new-workspace-form")).toBeVisible();
    await page.getByTestId("new-workspace-name").fill("三郎の会社");
    await page.getByTestId("new-workspace-submit").click();
    await expect(page.getByTestId("app")).toBeVisible();
    releaseMe();
    await expect(other.getByTestId("user-menu")).toContainText("鈴木 三郎", { timeout: 15_000 });
  } finally {
    releaseMe();
    await other.unroute("**/api/me");
    await other.unroute("**/api/sync**");
  }
});

test("別のタブに未送信の変更があるときは、切り替えない", async ({ page }) => {
  const { jiro } = await signInTwoAccounts(page);
  await waitForSynced(page);
  const other = await page.context().newPage();
  await other.goto(`/${jiro.ws}/team/DEF/all`);
  await dismissWelcome(other);
  if ((await other.getByTestId("issue-row").count()) === 0) {
    await other.getByTestId("sidebar-create").click();
    await other.getByTestId("create-title").fill("オフラインで確認する課題");
    await other.keyboard.press("ControlOrMeta+Enter");
    await expect(other.getByTestId("issue-row").first()).toBeVisible();
  }
  // 応答を返さないので、変更は送信待ちのまま残る。この指定はこのページにしか効かない
  await other.route("**/api/mutate**", () => {});
  await other.getByTestId("issue-row").first().click();
  const title = other.getByTestId("issue-title");
  await title.fill("別のタブで編集");
  await title.press("Enter");
  await page.getByTestId("user-menu").click();
  await accountRows(page).filter({ hasText: "山田 花子" }).click();
  await expect(page.getByTestId("toast")).toContainText("別のタブに未送信の変更");
  await expect(page.getByTestId("user-menu")).toContainText("佐藤 次郎");
  await other.unroute("**/api/mutate**");
  await other.close();
});

test("アカウントを追加しているあいだにほかのタブでできた変更は、元のアカウントに戻して送れる", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "山田 花子", workspace: "花子の会社" });
  const other = await page.context().newPage();
  await other.goto(`/${ws}/team/DEF/all`);
  await dismissWelcome(other);
  // 送れない変更として残す。この指定はこのページにしか効かない
  await other.route("**/api/mutate**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await other.getByTestId("issue-row").first().click();
  const title = other.getByTestId("issue-title");
  await title.fill("アカウントの追加中に編集");
  await title.press("Enter");
  await expect(other.getByTestId("sync-status")).toContainText("オフライン", { timeout: 10_000 });
  // Google から戻ってきたのと同じく、このタブだけ別のアカウントになる
  await devSignIn(page, { name: "佐藤 次郎" });
  await page.goto("/").catch((err: unknown) => {
    if (!String(err).includes("ERR_ABORTED")) throw err;
  });
  await expect(other.getByTestId("confirm-dialog")).toContainText("まだ送っていない変更", { timeout: 15_000 });
  await other.unroute("**/api/mutate**");
  await other.getByTestId("confirm-ok").click();
  await expect(other.getByTestId("sync-status")).toContainText("同期済み", { timeout: 40_000 });
  await expect(other.getByTestId("user-menu")).toContainText("山田 花子");
  await other.reload();
  await expect(other.getByTestId("issue-title")).toHaveValue("アカウントの追加中に編集");
});

test("同じアカウントへの切り替えの知らせでは、読み込み直さない", async ({ page }) => {
  await signupViaUi(page, { name: "山田 花子" });
  await waitForSynced(page);
  const me = (await (await page.request.get("/api/me")).json()) as { user: { id: string } };
  await page.evaluate(() => {
    (window as unknown as { __marker?: number }).__marker = 1;
  });
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByTestId("app")).toBeVisible();
  await other.evaluate((id) => {
    const ch = new BroadcastChannel("sen:session");
    ch.postMessage({ type: "account-changed", userId: id });
    ch.close();
  }, me.user.id);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await other.evaluate(() => {
    const ch = new BroadcastChannel("sen:session");
    ch.postMessage({ type: "account-changed" });
    ch.close();
  });
  // 読み込み直しの途中は実行コンテキストが消える。落ち着いて印が消えるまで待つ
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __marker?: number }).__marker).catch(() => 1))
    .toBeUndefined();
});

test("元のアカウントに戻すのに失敗しても、変更は残り、もう一度試せる", async ({ page }) => {
  const { ws } = await signupViaUi(page, { name: "山田 花子", workspace: "花子の会社" });
  const other = await page.context().newPage();
  await other.goto(`/${ws}/team/DEF/all`);
  await dismissWelcome(other);
  // 送れない変更として残す。この指定はこのページにしか効かない
  await other.route("**/api/mutate**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await other.getByTestId("issue-row").first().click();
  const title = other.getByTestId("issue-title");
  await title.fill("アカウントの追加中に編集");
  await title.press("Enter");
  await expect(other.getByTestId("sync-status")).toContainText("オフライン", { timeout: 10_000 });
  // Google から戻ってきたのと同じく、このタブだけ別のアカウントになる
  await devSignIn(page, { name: "佐藤 次郎" });
  await page.goto("/").catch((err: unknown) => {
    if (!String(err).includes("ERR_ABORTED")) throw err;
  });
  await expect(other.getByTestId("confirm-dialog")).toContainText("まだ送っていない変更", { timeout: 15_000 });
  await other.unroute("**/api/mutate**");
  await other.route("**/api/accounts/switch", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "サーバーでエラーが発生しました" }) }),
  );
  await other.getByTestId("confirm-ok").click();
  await expect(other.getByTestId("confirm-dialog")).toContainText("元のアカウントに戻せませんでした");
  await expect(other.getByTestId("confirm-ok")).toHaveText("もう一度試す");
  await expect(other.getByTestId("issue-title")).toHaveValue("アカウントの追加中に編集");
  await other.unroute("**/api/accounts/switch");
  await other.getByTestId("confirm-ok").click();
  await expect(other.getByTestId("sync-status")).toContainText("同期済み", { timeout: 40_000 });
  // 戻した知らせで、もう一方のタブが開き直して同じ知らせを返す。起動中の画面がそれを受けるとトップへ飛ぶので、届き終わってから読み込み直す
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子", { timeout: 15_000 });
  await expect(other.getByTestId("issue-title")).toHaveValue("アカウントの追加中に編集");
  await other.reload();
  await expect(other.getByTestId("issue-title")).toHaveValue("アカウントの追加中に編集");
});

test("切り替えているあいだは、画面を操作できない", async ({ page }) => {
  await signInTwoAccounts(page);
  await waitForSynced(page);
  await page.route("**/api/accounts/switch", async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  await page.getByTestId("user-menu").click();
  await accountRows(page).filter({ hasText: "山田 花子" }).click();
  await expect(page.getByTestId("toast")).toContainText("アカウントを切り替えています…");
  await expect.poll(() => page.evaluate(() => document.getElementById("root")!.inert)).toBe(true);
  await expect(page.getByTestId("user-menu")).toContainText("山田 花子", { timeout: 15_000 });
  await page.unroute("**/api/accounts/switch");
});
