import { expect, test } from "@playwright/test";
import { htmlToMarkdown, markdownToHtml } from "../../worker/markdown";

test("見出し・装飾・リスト・リンクを HTML にする", () => {
  expect(markdownToHtml("# 見出し1\n## 見出し2\n### 見出し3")).toBe("<h1>見出し1</h1>\n<h2>見出し2</h2>\n<h3>見出し3</h3>");
  expect(markdownToHtml("これは **太字** です")).toBe("<p>これは <strong>太字</strong> です</p>");
  expect(markdownToHtml("これは *斜体* です")).toBe("<p>これは <em>斜体</em> です</p>");
  expect(markdownToHtml("これは ~~取消~~ です")).toBe("<p>これは <s>取消</s> です</p>");
  expect(markdownToHtml("インライン `code` です")).toBe("<p>インライン <code>code</code> です</p>");
  expect(markdownToHtml("```ts\nconst a = 1;\n```")).toBe('<pre><code class="language-ts">const a = 1;\n</code></pre>');
  expect(markdownToHtml("> 引用です")).toBe("<blockquote>\n<p>引用です</p>\n</blockquote>");
  expect(markdownToHtml("- 親\n  - 子\n- 次")).toBe("<ul>\n<li>親<ul>\n<li>子</li>\n</ul></li>\n<li>次</li>\n</ul>");
  expect(markdownToHtml("1. 一\n2. 二")).toBe("<ol>\n<li>一</li>\n<li>二</li>\n</ol>");
  expect(markdownToHtml("[Sen](https://example.com)")).toBe('<p><a href="https://example.com">Sen</a></p>');
});

test("項目がすべてチェックのリストはチェックリストになる", () => {
  const html = markdownToHtml("- [x] 済み\n- [ ] 未");
  expect(html).toBe(
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked disabled></label><div><p>済み</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox" disabled></label><div><p>未</p></div></li></ul>',
  );
  expect(html).toContain('<ul data-type="taskList">');
  expect(html).toContain('<li data-type="taskItem" data-checked="true">');
  expect(html).toContain('<li data-type="taskItem" data-checked="false">');
  expect(html).not.toContain("<ol");
});

test("スクリプトや危険なリンクはタグにならない", () => {
  const script = markdownToHtml("<script>alert(1)</script>");
  expect(script).not.toContain("<script");
  expect(script).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

  const img = markdownToHtml("<img src=x onerror=alert(1)>");
  expect(img).not.toMatch(/<img[\s>]/i);
  expect(img).toContain("&lt;img src=x onerror=alert(1)&gt;");

  const js = markdownToHtml("[x](javascript:alert(1))");
  expect(js).not.toContain("<a");
  expect(js).not.toContain("javascript:");
  expect(js).toContain("x");
});

test("見出しは h3 まで、表はコード、空文字はそのまま", () => {
  expect(markdownToHtml("##### 深い")).toBe("<h3>深い</h3>");
  expect(markdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("<pre><code>| a | b |\n| --- | --- |\n| 1 | 2 |</code></pre>");
  expect(markdownToHtml("")).toBe("");
  expect(markdownToHtml("   \n")).toBe("");
});

test("HTML から Markdown へおおむね戻る", () => {
  const md = ["## 見出し", "", "- 親", "  - 子", "", "- [x] 済み", "- [ ] 未", "", "```ts", "const a = 1;", "```", "", "[Sen](https://example.com)"].join("\n");
  const back = htmlToMarkdown(markdownToHtml(md));
  expect(back).toBe(["## 見出し", "- 親", "  - 子", "- [x] 済み", "- [ ] 未", "", "```ts", "const a = 1;", "```", "", "[Sen](https://example.com)"].join("\n"));
  expect(back).toContain("## 見出し");
  expect(back).toContain("  - 子");
  expect(back).toContain("- [x] 済み");
  expect(back).toContain("- [ ] 未");
  expect(back).toContain("```ts\nconst a = 1;\n```");
  expect(back).toContain("[Sen](https://example.com)");
});

test("Tiptap の HTML を Markdown にでき、壊れた HTML でも例外にならない", () => {
  const tiptap =
    '<p>a<br>b</p><ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>済み</p></div></li></ul>';
  expect(htmlToMarkdown(tiptap)).toBe("a\nb\n- [x] 済み");
  expect(htmlToMarkdown("<p>A &amp; B &lt; C</p>")).toBe("A & B < C");
  expect(htmlToMarkdown("<p><b>unterminated")).toBe("**unterminated**");
  expect(() => htmlToMarkdown("<<not a tag")).not.toThrow();
  expect(() => htmlToMarkdown("<div><p>閉じない")).not.toThrow();
});
