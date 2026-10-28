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

  // 知らない行き先（Object のプロパティ名を含む）は、いつもの画面へ
  for (const open of ["unknown", "constructor", "__proto__"]) {
    await page.goto(`/?open=${open}`);
    await expect(page).toHaveURL(new RegExp(`/${ws}/my-issues/assigned$`));
    await expect(page.getByTestId("create-title")).toBeHidden();
  }
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

/**
 * 新しい版を公開する。drop を指定すると、画面で使っている JS / CSS を含まない版（= 画面のコードが古くなった）にする。
 * broken を指定すると、取得できないファイルを含む版（= インストールに失敗する）にする
 */
async function publishNextVersion(page: Page, opts: { version: string; drop?: "js" | "css"; broken?: boolean }) {
  originalSw ??= readFileSync(SW_FILE, "utf8");
  let source = originalSw.replace(/const VERSION = "\w+";/, `const VERSION = "${opts.version}";`);
  if (opts.broken) source = source.replace("const PRECACHE = [", 'const PRECACHE = [\n  "/api/__missing",');
  if (opts.drop) {
    const file = await page.evaluate((drop) => {
      const el = document.querySelector<HTMLScriptElement & HTMLLinkElement>(drop === "js" ? "script[type=module][src]" : 'link[rel="stylesheet"]')!;
      return new URL(el.src || el.href).pathname;
    }, opts.drop);
    expect(source).toContain(`"${file}",`);
    source = source.replace(`"${file}",`, "");
  }
  writeFileSync(SW_FILE, source);
  // vite preview は起動時の中身で ETag を返すので、ブラウザの HTTP キャッシュを消して書き換えた sw.js を取りに行かせる
  // （本番の Cloudflare は中身が変われば ETag も変わる）
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update().catch(() => {
      // インストールに失敗する版では、ここで失敗することがある
    });
  });
}

const cacheNames = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("sen-")));
const hasWaiting = (page: Page) => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
/** インストール中・待機中の版がなく、切り替えが終わっている */
const settled = (page: Page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !reg?.installing && !reg?.waiting && reg?.active?.state === "activated";
  });

/** サービスワーカーが有効になった状態で、課題の一覧を開いておく */
async function openInstalledApp(page: Page) {
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/my-issues`);
  await precached(page);
  await page.reload();
  await waitForSynced(page);
  return ws;
}

test("新しいバージョンが公開されると更新を案内し、押すと新しい版で読み込み直す", async ({ page, context }) => {
  const ws = await openInstalledApp(page);
  // 同じアプリを別のタブでも開いておく
  const other = await context.newPage();
  await other.goto(`/${ws}/inbox`);
  await expect(other.getByTestId("app")).toBeVisible();

  await publishNextVersion(page, { version: "next", drop: "js" });
  const notice = page.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" });
  await expect(notice).toBeVisible();
  // 押すまでは古い版のまま（勝手に読み込み直さない）
  await page.waitForTimeout(1000);
  expect(await hasWaiting(page)).toBe(true);

  const reloaded = page.waitForEvent("load");
  await notice.getByRole("button", { name: "更新" }).click();
  await reloaded;
  await expect(page.getByTestId("app")).toBeVisible();
  expect(await hasWaiting(page)).toBe(false);
  // 古いタブのために、1つ前の版も残しておく
  expect(await cacheNames(page)).toHaveLength(2);
  expect(await cacheNames(page)).toContain("sen-next");

  // 別のタブは古いコードのままなので、読み込み直しを案内する
  const switched = other.getByTestId("toast").filter({ hasText: "新しいバージョンに更新されました" });
  await expect(switched).toBeVisible();
  await expect(other.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" })).toHaveCount(0);
  const otherReloaded = other.waitForEvent("load");
  await switched.getByRole("button", { name: "再読み込み" }).click();
  await otherReloaded;
  await expect(other.getByTestId("app")).toBeVisible();
});

test("CSS だけが変わった版でも、更新を案内する", async ({ page }) => {
  await openInstalledApp(page);
  await publishNextVersion(page, { version: "css-only", drop: "css" });
  await expect(page.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" })).toBeVisible();
});

test("画面がすでに新しい版なら、案内を出さずに保存内容だけ入れ替える", async ({ page }) => {
  await openInstalledApp(page);
  const [original] = await cacheNames(page);

  await publishNextVersion(page, { version: "same-code" });
  await expect.poll(() => cacheNames(page)).toEqual([original, "sen-same-code"]);
  await expect.poll(() => settled(page)).toBe(true);
  // さらに次の版が来たら、いちばん古い版は消す
  await publishNextVersion(page, { version: "same-code-2" });
  await expect.poll(() => cacheNames(page)).toEqual(["sen-same-code", "sen-same-code-2"]);
  await expect(page.getByTestId("toast").filter({ hasText: "新しいバージョン" })).toHaveCount(0);
});

test("インストールに失敗した版や使われずに置き換わった版ではなく、1つ前に使っていた版を残す", async ({ page }) => {
  await openInstalledApp(page);
  const [original] = await cacheNames(page);

  // 待機中の版（b）が、使われる前にさらに新しい版（c）に置き換わり、c に更新する
  await publishNextVersion(page, { version: "b", drop: "js" });
  await expect.poll(() => hasWaiting(page)).toBe(true);
  await publishNextVersion(page, { version: "c", drop: "js" });
  await expect.poll(() => cacheNames(page)).toEqual([original, "sen-b", "sen-c"]);
  const notice = page.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" });
  await expect(notice).toBeVisible();
  const reloaded = page.waitForEvent("load");
  await notice.getByRole("button", { name: "更新" }).click();
  await reloaded;
  await expect.poll(() => cacheNames(page)).toEqual([original, "sen-c"]);

  // インストールに失敗した版（broken）を挟んでから、次の版（d）に切り替わる
  await publishNextVersion(page, { version: "broken", broken: true });
  await expect.poll(() => cacheNames(page)).toContain("sen-broken");
  await expect.poll(() => settled(page)).toBe(true);
  await publishNextVersion(page, { version: "d" });
  await expect.poll(() => cacheNames(page)).toEqual(["sen-c", "sen-d"]);
});

test("更新する前に、書きかけの説明文は保存し、作成中の課題は捨ててよいか確かめる", async ({ page }) => {
  const ws = await openInstalledApp(page);
  await page.goto(`/${ws}/projects`);
  await page.getByTestId("project-row").first().click();
  await expect(page.getByTestId("project-page")).toBeVisible();
  await publishNextVersion(page, { version: "next", drop: "js" });
  const notice = page.getByTestId("toast").filter({ hasText: "新しいバージョンがあります" });
  await expect(notice).toBeVisible();

  // 作成中の課題は読み込み直すと消えるので、確かめる。やめれば何も起きない
  await page.getByTestId("sidebar-create").click();
  await page.getByTestId("create-title").fill("書きかけの課題");
  await notice.getByRole("button", { name: "更新" }).click();
  await expect(page.getByTestId("confirm-ok")).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByTestId("create-title")).toHaveValue("書きかけの課題");
  expect(await hasWaiting(page)).toBe(true);
  await page.getByTestId("create-title").fill("");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("create-title")).toBeHidden();

  // プロジェクトの説明文は入力が止まってから保存される。保存の前に更新しても、保存してから切り替わる
  const description = page.locator(".project-page .detail-description .ProseMirror");
  await description.click();
  await page.keyboard.press("End");
  await page.keyboard.type("オフラインでも使える");
  await page.getByTestId("workspace-menu").click();
  const reloaded = page.waitForEvent("load");
  await page.locator(".menu-item", { hasText: "新しいバージョンに更新" }).click();
  await reloaded;
  await expect(page.getByTestId("project-page")).toBeVisible();
  await expect(description).toContainText("オフラインでも使える");
  expect(await hasWaiting(page)).toBe(false);
});
