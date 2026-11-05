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
