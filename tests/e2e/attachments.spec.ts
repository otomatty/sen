import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AttachmentUploadResponse, BootstrapPayload } from "../../shared/types";
import { signupViaUi } from "./helpers";

// 1×1 の PNG。拡張子や MIME だけでなく、実際の画像の読み込みも確かめる。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\nattachment test\n%%EOF");

async function bootstrap(page: Page, ws: string) {
  const response = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  expect(response.ok()).toBeTruthy();
  return await response.json() as BootstrapPayload;
}

async function setupIssue(page: Page) {
  const { ws } = await signupViaUi(page);
  const team = (await bootstrap(page, ws)).teams[0];
  const id = randomUUID();
  const response = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: { ops: [{ clientId: randomUUID(), mutation: { type: "issue.create", args: { id, teamId: team.id, title: "添付のテスト", description: "" } } }] },
  });
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).results[0].ok).toBe(true);
  const stored = (await bootstrap(page, ws)).issues.find((issue) => issue.id === id);
  expect(stored).toBeTruthy();
  const path = `/${ws}/issue/${team.key}-${stored!.number}`;
  await page.goto(path);
  const editor = page.getByTestId("issue-description");
  await expect(editor).toHaveClass(/ProseMirror/);
  await expect(attachInput(editor)).toBeAttached();
  return { ws, id, path, editor };
}

function attachInput(editor: Locator) {
  return editor.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' editor ')][1]").getByTestId("editor-attach-input");
}

async function pasteImage(editor: Locator, name = "screen.png") {
  await editor.click();
  await editor.evaluate((element, { bytes, name }) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([new Uint8Array(bytes)], name, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, { bytes: [...PNG], name });
}

async function expectImage(editor: Locator, name = "screen.png") {
  const image = editor.locator('img[src*="/api/files/"]');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("alt", name);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 1)).toBe(true);
  return image;
}

async function description(page: Page, ws: string, id: string) {
  return (await bootstrap(page, ws)).issues.find((issue) => issue.id === id)?.description;
}

async function upload(page: Page, ws: string, name: string, data: Buffer, client = true) {
  return page.request.post(`/api/files?ws=${encodeURIComponent(ws)}`, {
    headers: { ...(client ? { "x-sen-client": "1" } : {}), "x-sen-filename": encodeURIComponent(name), "content-type": "application/octet-stream" },
    data,
  });
}

// 応答を明示的に解放するまで保留し、遅い回線での状態を安定して確認する。
async function holdUploads(page: Page) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/files?**", async (route) => {
    await held;
    await route.continue().catch(() => { /* エディタを閉じた場合はリクエストが取り消される */ });
  });
  return release;
}

test("health がファイル添付の有効化を返す", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).files).toBe(true);
});

test("説明へ PNG を貼り付けると Markdown に保存され、再読み込みでも画像が出る", async ({ page, baseURL }) => {
  const { ws, id, editor } = await setupIssue(page);
  await pasteImage(editor);
  await expectImage(editor);
  await expect(page.getByTestId("upload-placeholder")).toHaveCount(0);
  await page.getByTestId("issue-title").click();
  await expect.poll(() => description(page, ws, id)).toMatch(/^!\[screen\.png\]\(http:\/\/localhost:\d+\/api\/files\/[0-9a-f-]{36}\/screen\.png\)$/);
  const url = (await editor.locator('img[src*="/api/files/"]').getAttribute("src"))!;
  expect(new URL(url).origin).toBe(baseURL);
  expect(await description(page, ws, id)).toBe(`![screen.png](${url})`);
  await page.reload();
  await expectImage(page.getByTestId("issue-description"));
});

test("ボタンから PDF を添付するとダウンロード用リンクと安全なヘッダーを返す", async ({ page }) => {
  const { editor } = await setupIssue(page);
  await attachInput(editor).setInputFiles({ name: "document.pdf", mimeType: "application/pdf", buffer: PDF });
  const link = editor.getByRole("link", { name: "document.pdf" });
  await expect(link).toBeVisible();
  await expect(editor.locator('img[src*="/api/files/"]')).toHaveCount(0);
  const response = await page.request.get((await link.getAttribute("href"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/octet-stream");
  expect(response.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(response.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
});

test("画像は image/png と inline で取得できる", async ({ page }) => {
  const { ws } = await setupIssue(page);
  const uploaded = await upload(page, ws, "screen.png", PNG);
  expect(uploaded.status()).toBe(201);
  const file = await uploaded.json() as AttachmentUploadResponse;
  expect(file.kind).toBe("image");
  const response = await page.request.get(file.url);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect(response.headers()["content-disposition"]).toMatch(/^inline/);
});

test("拡張子が png の SVG は画像ではなくダウンロードになる", async ({ page }) => {
  const { ws } = await setupIssue(page);
  const uploaded = await upload(page, ws, "evil.png", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  expect(uploaded.status()).toBe(201);
  const file = await uploaded.json() as AttachmentUploadResponse;
  expect(file.kind).toBe("file");
  const response = await page.request.get(file.url);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("application/octet-stream");
  expect(response.headers()["content-disposition"]).toMatch(/^attachment/);
});

test("括弧を含むファイル名も再読み込み後に元の alt で画像になる", async ({ page }) => {
  const { ws, id, editor } = await setupIssue(page);
  const name = "画面 a]b [1 (2).png";
  await pasteImage(editor, name);
  await expectImage(editor, name);
  await page.getByTestId("issue-title").click();
  await expect.poll(() => description(page, ws, id)).toContain("/api/files/");
  await page.reload();
  await expectImage(page.getByTestId("issue-description"), name);
});

test("添付は未ログインなら 401、別ワークスペースの人なら 404 になる", async ({ page, browser }) => {
  const { ws } = await setupIssue(page);
  const uploaded = await upload(page, ws, "private.png", PNG);
  expect(uploaded.status()).toBe(201);
  const file = await uploaded.json() as AttachmentUploadResponse;
  const anonymous = await browser.newContext();
  const outsider = await browser.newContext();
  try {
    expect((await anonymous.request.get(file.url)).status()).toBe(401);
    const otherPage = await outsider.newPage();
    await signupViaUi(otherPage);
    expect((await outsider.request.get(file.url)).status()).toBe(404);
  } finally {
    await anonymous.close();
    await outsider.close();
  }
});

test("x-sen-client の無いアップロードは 403 になる", async ({ page }) => {
  const { ws } = await setupIssue(page);
  expect((await upload(page, ws, "screen.png", PNG, false)).status()).toBe(403);
});

test("コメントへ貼り付けた画像を送信できる", async ({ page }) => {
  await setupIssue(page);
  const editor = page.getByTestId("comment-input");
  await pasteImage(editor);
  await expectImage(editor);
  await page.getByTestId("comment-submit").click();
  await expectImage(page.getByTestId("comment").last());
});

test("アップロード中はコメントを送信できず、完了後に送信できる", async ({ page }) => {
  await setupIssue(page);
  const release = await holdUploads(page);
  try {
    await pasteImage(page.getByTestId("comment-input"));
    await expect(page.getByTestId("upload-placeholder")).toContainText("screen.png をアップロード中…");
    await expect(page.getByTestId("comment-submit")).toBeDisabled();
    release();
    await expect(page.getByTestId("upload-placeholder")).toHaveCount(0);
    await expect(page.getByTestId("comment-submit")).toBeEnabled();
    await page.getByTestId("comment-submit").click();
    await expectImage(page.getByTestId("comment").last());
  } finally { release(); }
});

test("アップロード中に別画面へ移ると取り消され、説明に画像が残らない", async ({ page }) => {
  const { ws, id, path, editor } = await setupIssue(page);
  const release = await holdUploads(page);
  try {
    await pasteImage(editor);
    await expect(page.getByTestId("upload-placeholder")).toBeVisible();
    await page.getByTestId("nav-inbox").click();
    await expect(page.getByText("添付を取り消しました", { exact: true })).toBeVisible();
    release();
    await page.goto(path);
    await expect(page.getByTestId("issue-description")).toHaveClass(/ProseMirror/);
    await expect(page.getByTestId("issue-description").locator('img[src*="/api/files/"]')).toHaveCount(0);
    expect(await description(page, ws, id)).toBe("");
  } finally { release(); }
});

test("オフラインでは添付できず、本文は変わらない", async ({ page, context }) => {
  const { editor } = await setupIssue(page);
  const before = await editor.innerHTML();
  try {
    await context.setOffline(true);
    await expect(attachInput(editor).locator("..").getByTestId("editor-attach")).toBeDisabled();
    await pasteImage(editor);
    await expect(page.getByText("オフラインのため添付できません", { exact: true })).toBeVisible();
    expect(await editor.innerHTML()).toBe(before);
    await expect(editor.locator('img[src*="/api/files/"]')).toHaveCount(0);
    await expect(page.getByTestId("upload-placeholder")).toHaveCount(0);
  } finally { await context.setOffline(false); }
});

test("26 MB の PDF は上限エラーになり、本文は変わらない", async ({ page }) => {
  const { editor } = await setupIssue(page);
  const before = await editor.innerHTML();
  await attachInput(editor).setInputFiles({ name: "large.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(26 * 1024 * 1024) });
  await expect(page.getByText("large.pdf を添付できませんでした（画像は 10 MB、それ以外は 25 MB までです）", { exact: true })).toBeVisible();
  expect(await editor.innerHTML()).toBe(before);
  await expect(page.getByTestId("upload-placeholder")).toHaveCount(0);
});
