import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { signupViaUi, waitForSynced } from "./helpers";

/** PNG の幅と高さ（IHDR チャンク） */
function pngSize(buf: Buffer) {
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

/** サービスワーカーが有効になるのを待ち、保存したファイルのパスを返す */
async function precached(page: Page) {
  return page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const name = (await caches.keys()).find((k) => k.startsWith("sen-"));
    if (!name) return [];
    return (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  });
}

test("インストールに必要なマニフェストとアイコンがそろっている", async ({ page, request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBeTruthy();
  const manifest = await res.json();
  expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", short_name: "Sen" });

  // Android やデスクトップの Chrome がインストールに求める 192px と 512px、ホーム画面用の maskable
  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
  for (const [sizes, purpose] of [
    ["192x192", "any"],
    ["512x512", "any"],
    ["192x192", "maskable"],
    ["512x512", "maskable"],
  ]) {
    expect(icons.some((i) => i.sizes === sizes && i.purpose === purpose && i.type === "image/png")).toBeTruthy();
  }
  for (const icon of icons.filter((i) => i.type === "image/png")) {
    const r = await request.get(icon.src);
    expect(r.ok()).toBeTruthy();
    expect(r.headers()["content-type"]).toContain("image/png");
    expect(pngSize(await r.body())).toBe(icon.sizes);
  }
  for (const s of manifest.screenshots as { src: string }[]) {
    expect((await request.get(s.src)).ok()).toBeTruthy();
  }
  for (const s of manifest.shortcuts as { url: string }[]) expect(s.url).toMatch(/^\/\?open=/);

  // iPhone / iPad のホーム画面用
  await page.goto("/login");
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  const r = await request.get(apple!);
  expect(pngSize(await r.body())).toBe("180x180");
});

test("遅れて読み込む画面も保存されるので、初めて開く画面もオフラインで開ける", async ({ page, context }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/team/ENG/all`);
  await expect(page.getByTestId("issue-row").first()).toBeVisible();

  // エディタ・ボードの JS とフォントも、インストールの時点でまとめて保存される
  const files = await precached(page);
  expect(files).toContain("/");
  expect(files).toContain("/manifest.webmanifest");
  expect(files.some((f) => /^\/assets\/EditorImpl-.+\.js$/.test(f))).toBeTruthy();
  expect(files.some((f) => /^\/assets\/IssueBoard-.+\.js$/.test(f))).toBeTruthy();
  expect(files.some((f) => /^\/assets\/.+\.woff2$/.test(f))).toBeTruthy();
  expect(files.some((f) => f.startsWith("/tutorials/"))).toBeFalsy();

  // データのキャッシュが書き込まれるのを待つ
  await waitForSynced(page);
  await page.waitForTimeout(2500);

  await context.setOffline(true);
  // まだ開いていない画面へ、URL を直接開いて移動する
  await page.goto(`/${ws}/issue/ENG-2`);
  await expect(page.getByTestId("issue-detail")).toBeVisible();
  await expect(page.getByTestId("issue-description")).toBeVisible();
  await expect(page.getByTestId("sync-status")).toContainText("オフライン", { timeout: 20_000 });
  await context.setOffline(false);
  await expect(page.getByTestId("sync-status")).toContainText("同期済み", { timeout: 40_000 });
});

test("アプリのショートカットから、受信トレイや課題の作成を直接開ける", async ({ page }) => {
  const { ws } = await signupViaUi(page);

  await page.goto("/?open=inbox");
  await expect(page).toHaveURL(new RegExp(`/${ws}/inbox$`));
  await expect(page.getByTestId("inbox-page")).toBeVisible();

  await page.goto("/?open=new-issue");
  await expect(page.getByTestId("create-title")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${ws}/my-issues/assigned$`));

  // 知らない行き先は、いつもの画面へ
  await page.goto("/?open=unknown");
  await expect(page).toHaveURL(new RegExp(`/${ws}/my-issues/assigned$`));
  await expect(page.getByTestId("create-title")).toBeHidden();
});

test("ブラウザがインストールを提案できるときは、メニューと設定からインストールできる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/settings/profile`);
  await expect(page.getByTestId("pwa-status")).toBeVisible();

  // Chrome の beforeinstallprompt の代わりに、同じ形のイベントを送る
  const fire = () =>
    page.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(e, {
        prompt: async () => {
          (window as unknown as { __prompted: number }).__prompted = ((window as unknown as { __prompted?: number }).__prompted ?? 0) + 1;
        },
        userChoice: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(e);
    });
  const prompted = () => page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted ?? 0);

  await fire();
  await page.getByTestId("pwa-install").click();
  await expect.poll(prompted).toBe(1);
  // 提案は一度しか使えないので、ボタンは消える
  await expect(page.getByTestId("pwa-install")).toBeHidden();

  await fire();
  await page.getByTestId("workspace-menu").click();
  await page.locator(".menu-item", { hasText: "アプリをインストール" }).click();
  await expect.poll(prompted).toBe(2);
});

// 新しい版の公開は、配信中のビルド（vite preview が毎回ディスクから読む）の sw.js を書き換えて再現する
const SW_FILE = fileURLToPath(new URL("../../dist/client/sw.js", import.meta.url));
let originalSw: string | null = null;
test.afterEach(() => {
  if (originalSw !== null) writeFileSync(SW_FILE, originalSw);
  originalSw = null;
});

async function publishNextVersion(page: Page, opts: { version: string; dropCurrentCode: boolean }) {
  originalSw = readFileSync(SW_FILE, "utf8");
  let source = originalSw.replace(/const VERSION = "\w+";/, `const VERSION = "${opts.version}";`);
  if (opts.dropCurrentCode) {
    // 画面で動いている JS を含まない版 = 画面のコードが古くなった
    const entry = await page.evaluate(() => new URL(document.querySelector<HTMLScriptElement>("script[type=module][src]")!.src).pathname);
    expect(source).toContain(`"${entry}",`);
    source = source.replace(`"${entry}",`, "");
  }
  writeFileSync(SW_FILE, source);
  // vite preview は起動時の中身で ETag を返すので、ブラウザの HTTP キャッシュを消して書き換えた sw.js を取りに行かせる
  // （本番の Cloudflare は中身が変われば ETag も変わる）
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
}

const cacheNames = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("sen-")));

test("新しいバージョンが公開されると更新を案内し、押すと新しい版で読み込み直す", async ({ page, context }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/my-issues`);
  await precached(page);
  await page.reload();
  await waitForSynced(page);
  // 同じアプリを別のタブでも開いておく
  const other = await context.newPage();
  await other.goto(`/${ws}/inbox`);
  await expect(other.getByTestId("app")).toBeVisible();

  await publishNextVersion(page, { version: "next", dropCurrentCode: true });
  const notice = page.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" });
  await expect(notice).toBeVisible();
  // 押すまでは古い版のまま（勝手に読み込み直さない）
  await page.waitForTimeout(1000);
  expect(await cacheNames(page)).toHaveLength(2);

  const reloaded = page.waitForEvent("load");
  await notice.getByRole("button", { name: "更新" }).click();
  await reloaded;
  await expect(page.getByTestId("app")).toBeVisible();
  await expect.poll(() => cacheNames(page)).toEqual(["sen-next"]);

  // 別のタブは古いコードのままなので、読み込み直しを案内する
  const switched = other.getByTestId("toast").filter({ hasText: "新しいバージョンに更新されました" });
  await expect(switched).toBeVisible();
  await expect(other.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" })).toHaveCount(0);
  const otherReloaded = other.waitForEvent("load");
  await switched.getByRole("button", { name: "再読み込み" }).click();
  await otherReloaded;
  await expect(other.getByTestId("app")).toBeVisible();
});

test("画面がすでに新しい版なら、案内を出さずに保存内容だけ入れ替える", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/my-issues`);
  await precached(page);
  await page.reload();
  await waitForSynced(page);

  await publishNextVersion(page, { version: "same-code", dropCurrentCode: false });
  await expect.poll(() => cacheNames(page)).toEqual(["sen-same-code"]);
  await expect(page.getByTestId("toast").filter({ hasText: "新しいバージョン" })).toHaveCount(0);
});
