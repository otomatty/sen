import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ISSUE_TITLE_MAX_LENGTH, MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import type { BootstrapPayload, Mutation } from "../../shared/types";
import { seedDemo, signupViaUi, waitForSynced } from "./helpers";

async function postMutation(page: Page, ws: string, mutation: Mutation) {
  const res = await page.request.post(`/api/mutate?ws=${encodeURIComponent(ws)}`, {
    headers: { "x-sen-client": "1" },
    data: { ops: [{ clientId: randomUUID(), mutation }] },
  });
  const text = await res.text();
  expect(res.ok(), text).toBeTruthy();
  const body = JSON.parse(text) as { results: { ok: boolean; error?: string }[] };
  return body.results[0];
}

async function bootstrap(page: Page, ws: string) {
  const res = await page.request.get(`/api/bootstrap?ws=${encodeURIComponent(ws)}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as BootstrapPayload;
}

async function createIssue(page: Page, ws: string, title: string, description: string) {
  const team = (await bootstrap(page, ws)).teams[0];
  expect(team).toBeTruthy();
  const id = randomUUID();
  const created = await postMutation(page, ws, { type: "issue.create", args: { id, teamId: team.id, title, description } });
  expect(created.ok, created.error).toBe(true);
  const stored = (await bootstrap(page, ws)).issues.find((issue) => issue.id === id);
  expect(stored).toBeTruthy();
  return { id, ident: `${team.key}-${stored!.number}` };
}

async function openIssue(page: Page, ws: string, ident: string) {
  await page.goto(`/${ws}/issue/${ident}`);
  const description = page.getByTestId("issue-description");
  await expect(description).toHaveClass(/ProseMirror/, { timeout: 15_000 });
  return description;
}

async function storedDescription(page: Page, ws: string, id: string) {
  return (await bootstrap(page, ws)).issues.find((issue) => issue.id === id)?.description;
}

test("課題を開いてクリックしてフォーカスを外しても、保存された Markdown は変わらない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const description = ["* 項目", "__太字__", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "```", "code", "```"].join("\r\n");
  const issue = await createIssue(page, ws, "開いただけ", description);
  await openIssue(page, ws, issue.ident);
  await page.getByTestId("issue-description").click();
  await page.getByTestId("issue-title").click();
  await page.waitForTimeout(1500);
  expect(await storedDescription(page, ws, issue.id)).toBe(description);
});

test("入力で見出し・表・注記・脚注・画像を作ると、GFM として保存される", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const issue = await createIssue(page, ws, "記法", "");
  const description = await openIssue(page, ws, issue.ident);

  await description.click();
  await page.keyboard.type("#### 節");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[^1] と ");
  await page.keyboard.type("![図](https://example.com/a.png)");
  await page.keyboard.press("Enter");
  await page.keyboard.type("> ");
  await page.keyboard.type("[!NOTE]");
  await page.keyboard.press("Space");
  await page.keyboard.type("メモ");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, issue.id)) ?? "", { timeout: 15_000 }).toContain("[!NOTE]");

  const saved = await storedDescription(page, ws, issue.id);
  expect(saved).toContain("#### 節");
  expect(saved).toContain("[^1]");
  expect(saved).toContain("![図](https://example.com/a.png)");
  expect(saved).toContain("[!NOTE]");
  expect(saved).toContain("メモ");

  const tableIssue = await createIssue(page, ws, "表の入力", "");
  const table = await openIssue(page, ws, tableIssue.ident);
  await table.click();
  await page.keyboard.type("| A | B |");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, tableIssue.id)) ?? "", { timeout: 15_000 }).toMatch(/\|\s*-{3,}\s*\|/);
  const tableSaved = (await storedDescription(page, ws, tableIssue.id)) ?? "";
  expect(tableSaved).toMatch(/\|\s*A\s*\|\s*B\s*\|/);
  expect(tableSaved).toMatch(/\|\s*-{3,}\s*\|\s*-{3,}\s*\|/);
});

test("表の操作バーで行・列の追加と削除、寄せの変更ができる", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const issue = await createIssue(page, ws, "表の操作", "| A | B |\n| --- | --- |\n| 1 | 2 |");
  const description = await openIssue(page, ws, issue.ident);
  await description.locator("td").first().click();
  for (const id of [
    "table-add-row-before",
    "table-add-row-after",
    "table-add-column-before",
    "table-add-column-after",
    "table-delete-row",
    "table-delete-column",
    "table-align-left",
    "table-align-center",
    "table-align-right",
    "table-delete",
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  await description.locator("th").first().click();
  await expect(page.getByTestId("table-delete-row")).toBeDisabled();
  await expect(page.getByTestId("table-add-row-before")).toBeDisabled();
  await description.locator("td").nth(1).click();
  await expect(page.getByTestId("table-add-row-before")).toBeEnabled();
  await page.getByTestId("table-align-center").click();
  await page.getByTestId("table-add-row-after").click();
  await page.getByTestId("table-add-column-before").click();
  await description.locator("tr").last().locator("td, th").first().click();
  await page.getByTestId("table-delete-row").click();
  await description.locator("th").nth(1).click();
  await expect(page.getByTestId("table-delete-row")).toBeDisabled();
  await page.getByTestId("table-delete-column").click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, issue.id)) ?? "", { timeout: 15_000 }).toMatch(/:-+:/);

  const saved = (await storedDescription(page, ws, issue.id)) ?? "";
  expect(saved).toMatch(/:-+:/);
  expect(saved).toContain("A");
  expect(saved).toContain("B");
  expect(saved).toContain("1");
  expect(saved).toContain("2");

  await description.locator("td").first().click();
  await page.getByTestId("table-delete-column").click();
  await expect(page.getByTestId("table-delete-column")).toBeDisabled();
});

test("変換中の Enter では、パイプの行が表にならない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const issue = await createIssue(page, ws, "変換", "");
  const description = await openIssue(page, ws, issue.ident);
  await description.click();
  await page.keyboard.type("| 名前 | 年齢 |");
  await description.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    which: 229,
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  await expect(description.locator("table")).toHaveCount(0);
  await expect(description).toContainText("| 名前 | 年齢 |");
});

// Chromium の CDP で IME の入力を再現し、変換中に文字を消してもひらがなのまま確定しないことを確かめる。
test("変換中に Backspace で文字を消しても、ひらがなのまま確定しない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const issue = await createIssue(page, ws, "変換中の削除", "");
  const description = await openIssue(page, ws, issue.ident);
  await description.click();
  const cdp = await page.context().newCDPSession(page);
  for (const text of ["せ", "せつ", "せつめ", "せつめい", "せつめ", "せつ", "せって", "せってい"]) {
    await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
    await page.waitForTimeout(50);
  }
  await expect(description).toHaveText("せってい");
  await cdp.send("Input.insertText", { text: "設定" });
  await expect(description).toHaveText("設定");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, issue.id)) ?? "", { timeout: 15_000 }).toBe("設定");
});

test("リストの中の注記と脚注は、開いただけでは保存し直されない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const note = "- 項目\n\n  > [!NOTE]\n  > リストの中の注記";
  const noteIssue = await createIssue(page, ws, "リストの注記", note);
  const noteEditor = await openIssue(page, ws, noteIssue.ident);
  await expect(noteEditor.locator(".md-alert")).toHaveAttribute("data-alert", "note");
  await expect(noteEditor.locator(".md-alert")).toContainText("リストの中の注記");
  await noteEditor.click();
  await page.getByTestId("issue-title").click();
  await page.waitForTimeout(1500);
  expect(await storedDescription(page, ws, noteIssue.id)).toBe(note);

  const footnote = "- 項目\n\n  [^1]: リストの中の脚注";
  const footIssue = await createIssue(page, ws, "リストの脚注", footnote);
  const footEditor = await openIssue(page, ws, footIssue.ident);
  await expect(footEditor.locator(".md-footnote")).toContainText("リストの中の脚注");
  await footEditor.click();
  await page.getByTestId("issue-title").click();
  await page.waitForTimeout(1500);
  expect(await storedDescription(page, ws, footIssue.id)).toBe(footnote);
});

test("段落の途中の脚注定義は、エディタでも表示でも定義にならない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const description = "本文\n[^1]: 続き";
  const issue = await createIssue(page, ws, "脚注の途中", description);
  await postMutation(page, ws, { type: "comment.create", args: { id: randomUUID(), issueId: issue.id, body: description } });
  const editor = await openIssue(page, ws, issue.ident);
  const comment = page.getByTestId("comment").last();
  await expect(comment).toBeVisible();
  await expect(editor.locator(".md-footnote")).toHaveCount(0);
  await expect(comment.locator(".md-footnote")).toHaveCount(0);
  await expect(editor).toContainText("本文");
  await expect(editor).toContainText("続き");
  await expect(comment).toContainText("本文");
  await expect(comment).toContainText("続き");
  await editor.click();
  await page.getByTestId("issue-title").click();
  await page.waitForTimeout(1500);
  expect(await storedDescription(page, ws, issue.id)).toBe(description);
});

test("表の操作バーは、表の上の文字に重ならない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const issue = await createIssue(page, ws, "表の余白", "表の上の注記です。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  const description = await openIssue(page, ws, issue.ident);
  await description.locator("td").first().click();
  const toolbar = page.locator(".table-toolbar");
  await expect(toolbar).toBeVisible();
  const before = description.locator(".tableWrapper").locator("xpath=preceding-sibling::*[1]");
  const toolbarBox = await toolbar.boundingBox();
  const beforeBox = await before.boundingBox();
  expect(toolbarBox).toBeTruthy();
  expect(beforeBox).toBeTruthy();
  const overlaps =
    toolbarBox!.x < beforeBox!.x + beforeBox!.width &&
    toolbarBox!.x + toolbarBox!.width > beforeBox!.x &&
    toolbarBox!.y < beforeBox!.y + beforeBox!.height &&
    toolbarBox!.y + toolbarBox!.height > beforeBox!.y;
  expect(overlaps).toBe(false);
});

test("GitHub の Issue に多い記法は、1 文字足して保存しても残る", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const description = [
    "<!-- テンプレートの説明 -->",
    "",
    "<details><summary>ログ</summary>",
    "本文",
    "</details>",
    "",
    "| A | B |",
    "| --- | --- |",
    "| a<br>b | c |",
    "",
    "> [!WARNING]",
    "> careful",
    "",
    "見よ [^1]",
    "",
    "![x](https://example.com/a.png)",
    "",
    "[^1]: 注",
    "",
    "末尾",
  ].join("\n");
  const issue = await createIssue(page, ws, "GitHub の本文", description);
  const editor = await openIssue(page, ws, issue.ident);
  await editor.locator("p").filter({ hasText: /^末尾/ }).click();
  await editor.press("End");
  await editor.pressSequentially("Z");
  await expect(editor).toContainText("末尾Z");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, issue.id)) ?? "", { timeout: 15_000 }).toContain("末尾Z");

  const saved = (await storedDescription(page, ws, issue.id)) ?? "";
  expect(saved).toContain("<details>");
  expect(saved).toContain("</details>");
  expect(saved).toContain("<!-- テンプレートの説明 -->");
  expect(saved).toContain("[!WARNING]");
  expect(saved).toContain("[^1]");
  expect(saved).toContain("https://example.com/a.png");
  expect(saved).toContain("a<br>b");
});

test("同じ本文に 1 文字足して保存を繰り返しても、2 回目以降は足した文字以外は変わらない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const description = [
    "<!-- テンプレートの説明 -->",
    "",
    "<details><summary>ログ</summary>",
    "本文",
    "</details>",
    "",
    "> [!NOTE]",
    "> 注記です",
    "",
    "| 左 | 中 | 右 |",
    "| :--- | :---: | ---: |",
    "| a<br>b | c | d |",
    "",
    "見よ [^1]",
    "",
    "![図](https://example.com/a.png)",
    "",
    "- [ ] 未了",
    "- [x] 完了",
    "",
    "a < b",
    "",
    "[^1]: 注",
    "",
    "末尾",
  ].join("\n");
  const issue = await createIssue(page, ws, "保存の安定", description);
  const marks = ["1", "2", "3"];
  let previous = "";
  for (let i = 0; i < marks.length; i++) {
    const editor = await openIssue(page, ws, issue.ident);
    await editor.locator("p").filter({ hasText: /^末尾/ }).click();
    await editor.press("End");
    await editor.pressSequentially(marks[i]);
    await expect(editor).toContainText(`末尾${marks.slice(0, i + 1).join("")}`);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await storedDescription(page, ws, issue.id)) ?? "", { timeout: 15_000 }).toContain(`末尾${marks.slice(0, i + 1).join("")}`);
    const saved = (await storedDescription(page, ws, issue.id)) ?? "";
    if (i > 0) expect(saved).toBe(previous + marks[i]);
    previous = saved;
  }
});

test("危険な HTML と javascript リンクは、エディタでもコメントでも実行されない", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  const nasty = '<img src=x onerror="window.__xss=1">\n\n[x](javascript:window.__xss=1)';
  const issue = await createIssue(page, ws, "安全性", nasty);
  await openIssue(page, ws, issue.ident);
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  await page.getByTestId("comment-input").click();
  await page.evaluate((text) => {
    const view = document.querySelector("[data-testid='comment-input']");
    if (!view) throw new Error("コメント欄がありません");
    const data = new DataTransfer();
    data.setData("text/plain", text);
    view.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, nasty);
  await page.keyboard.press("Control+Enter");
  const comment = page.getByTestId("comment").last();
  await expect(comment).toContainText("onerror");
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("[href*='javascript']")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("コメントの表と注記が表示され、メンションは強調される", async ({ page }) => {
  const { ws } = await signupViaUi(page);
  await seedDemo(page.request, ws);
  const issue = await createIssue(page, ws, "コメントの表示", "");
  await openIssue(page, ws, issue.ident);
  await page.getByTestId("comment-input").click();
  await page.keyboard.type("@佐藤");
  await expect(page.getByTestId("mention-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const view = document.querySelector("[data-testid='comment-input']");
    if (!view) throw new Error("コメント欄がありません");
    const data = new DataTransfer();
    data.setData("text/plain", "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> [!NOTE]\n> メモです\n");
    view.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await page.keyboard.press("Control+Enter");
  const comment = page.getByTestId("comment").last();
  await expect(comment.locator("table")).toBeVisible();
  await expect(comment.locator("td").first()).toHaveText("1");
  await expect(comment.locator(".md-alert")).toHaveAttribute("data-alert", "note");
  await expect(comment.locator(".md-alert")).toContainText("メモです");
  await expect(comment.locator(".mention")).toContainText("佐藤 花子");
});

test("日本語の句読点を太字にすると、保存した Markdown では句読点が太字の外に出る", async ({ page }) => {
  const { ws } = await signupViaUi(page);

  const quote = await createIssue(page, ws, "かぎ括弧", "");
  const quoteEditor = await openIssue(page, ws, quote.ident);
  await quoteEditor.click();
  await page.keyboard.type("「重要」です");
  await selectText(quoteEditor, "「重要」");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, quote.id)) ?? "", { timeout: 15_000 }).toBe("「**重要**」です");
  await page.reload();
  const quoteAgain = await openIssue(page, ws, quote.ident);
  await expect(quoteAgain.locator("strong")).toHaveText("重要");
  await expect(quoteAgain).toContainText("「重要」です");
  await expect(quoteAgain).not.toContainText("**");

  const period = await createIssue(page, ws, "句点", "");
  const periodEditor = await openIssue(page, ws, period.ident);
  await periodEditor.click();
  await page.keyboard.type("重要。次に");
  await selectText(periodEditor, "重要。");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await storedDescription(page, ws, period.id)) ?? "", { timeout: 15_000 }).toBe("**重要**。次に");
  await page.reload();
  const periodAgain = await openIssue(page, ws, period.ident);
  await expect(periodAgain.locator("strong")).toHaveText("重要");
  await expect(periodAgain).toContainText("重要。次に");
  await expect(periodAgain).not.toContainText("**");
});

async function selectText(editor: ReturnType<Page["getByTestId"]>, target: string) {
  await editor.evaluate((el, text) => {
    const view = el as HTMLElement & {
      editor?: {
        chain: () => {
          focus: () => {
            setTextSelection: (range: { from: number; to: number }) => { run: () => void };
          };
        };
        state: {
          doc: {
            descendants: (f: (node: { isText: boolean; text?: string }, pos: number) => void) => void;
          };
        };
      };
    };
    const tiptap = view.editor;
    if (!tiptap) throw new Error("エディタがありません");
    let from = -1;
    tiptap.state.doc.descendants((node, pos) => {
      if (from >= 0 || !node.isText || !node.text) return;
      const index = node.text.indexOf(text);
      if (index >= 0) from = pos + index;
    });
    if (from < 0) throw new Error(`「${text}」がありません`);
    tiptap.chain().focus().setTextSelection({ from, to: from + text.length }).run();
  }, target);
}

test("作成画面のタイトルは 256 文字で止まり、長すぎる説明は保存されない", async ({ page }) => {
  test.setTimeout(120_000);
  const { ws } = await signupViaUi(page);
  await page.goto(`/${ws}/my-issues`);
  await waitForSynced(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  const title = page.getByTestId("create-title");
  await expect(title).toBeVisible();
  await title.fill("あ".repeat(ISSUE_TITLE_MAX_LENGTH + 1));
  await expect(title).toHaveValue("あ".repeat(ISSUE_TITLE_MAX_LENGTH));
  await page.keyboard.press("Escape");

  const description = "あ".repeat(MARKDOWN_MAX_LENGTH);
  const issue = await createIssue(page, ws, "説明の上限", description);
  const editor = await openIssue(page, ws, issue.ident);
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("あ");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("toast").filter({ hasText: "65,536" })).toBeVisible({ timeout: 15_000 });
  expect(await storedDescription(page, ws, issue.id)).toBe(description);
});
