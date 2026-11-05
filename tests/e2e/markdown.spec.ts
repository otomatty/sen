import { expect, test } from "@playwright/test";
import { markdownToHtml, markdownToText } from "../../shared/markdown";
import { htmlToMarkdown } from "../../worker/markdown";

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
  expect(markdownToHtml("a\nb")).toBe("<p>a<br>b</p>");
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

test("見出しは h6 まで、表は table、空文字はそのまま", () => {
  expect(markdownToHtml("##### 深い")).toBe("<h5>深い</h5>");
  expect(markdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(
    "<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>",
  );
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

test("相対リンクとページ内リンクは往復してもリンクのまま残る", () => {
  const docs = markdownToHtml(htmlToMarkdown('<a href="/docs">/docs</a>'));
  expect(docs).toContain('<a href="/docs">/docs</a>');
  const goal = markdownToHtml(htmlToMarkdown('<a href="#goal">目的</a>'));
  expect(goal).toContain('<a href="#goal">目的</a>');
});

test("詰まったリストのインラインは 1 行のまま往復する", () => {
  const md = "- Run `bun test` before deploying\n- **重要** な [リンク](https://e.com) です";
  expect(htmlToMarkdown(markdownToHtml(md))).toBe(md);
  expect(htmlToMarkdown(markdownToHtml("- **a** *b*"))).toBe("- **a** *b*");
  expect(htmlToMarkdown("<p>a <strong>b</strong> c</p>")).toBe("a **b** c");
});

test("リンク先の文字参照は一度だけエスケープする", () => {
  expect(markdownToHtml("[検索](/search?a=1&amp;b=2)")).toBe('<p><a href="/search?a=1&amp;b=2">検索</a></p>');
  expect(markdownToHtml("[検索](/search?a=1&b=2)")).toBe('<p><a href="/search?a=1&amp;b=2">検索</a></p>');
  expect(markdownToHtml("![図](/search?a=1&amp;b=2)")).toBe("<p>図</p>");
});

test("括弧を含むリンク先は往復しても切れない", () => {
  expect(htmlToMarkdown('<a href="/docs/a)">資料</a>')).toBe("[資料](</docs/a)>)");
  expect(markdownToHtml(htmlToMarkdown('<a href="/docs/a)">資料</a>'))).toBe('<p><a href="/docs/a)">資料</a></p>');
  expect(htmlToMarkdown('<a href="https://example.com/wiki/Foo_(bar)">Foo</a>')).toBe("[Foo](<https://example.com/wiki/Foo_(bar)>)");
  expect(markdownToHtml(htmlToMarkdown('<a href="https://example.com/wiki/Foo_(bar)">Foo</a>'))).toBe(
    '<p><a href="https://example.com/wiki/Foo_(bar)">Foo</a></p>',
  );
  expect(htmlToMarkdown('<a href="/docs/a<b>">x</a>')).toBe("[x](</docs/a%3Cb%3E>)");
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

/** タグを除き、文字参照を1回だけ戻し、空白をまとめる。以前の htmlToText と同じ考え方 */
function htmlVisibleText(html: string): string {
  const stripped = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d|blockquote|pre|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  const decoded = stripped.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, ent: string) => {
    const e = ent.toLowerCase();
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default: {
        const hex = e.startsWith("#x");
        const cp = hex ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
        return String.fromCodePoint(cp);
      }
    }
  });
  return decoded.replace(/\s+/g, " ").trim();
}

function tagCount(html: string, re: RegExp): number {
  return html.match(re)?.length ?? 0;
}

test("段落の先頭でも、行内コードと装飾は記法のまま残る", () => {
  expect(markdownToHtml(htmlToMarkdown("<p><code>a``b</code></p>"))).toContain("<code>a``b</code>");
  expect(markdownToHtml(htmlToMarkdown("<p><code>`x`</code> 後</p>"))).toContain("<code>`x`</code>");
  expect(markdownToHtml(htmlToMarkdown("<p><strong>#</strong> と</p>"))).toContain("<strong>#</strong>");
  expect(markdownToHtml(htmlToMarkdown("<p><em>-</em> と</p>"))).toContain("<em>-</em>");
});

test("テキストの ~ は 1 つでもエスケープし、コードの中はそのまま残す", () => {
  expect(markdownToHtml(htmlToMarkdown("<p>月~金、土~日</p>"))).toBe("<p>月~金、土~日</p>");
  expect(markdownToHtml(htmlToMarkdown("<p>~~二重~~</p>"))).toBe("<p>~~二重~~</p>");
  expect(markdownToHtml(htmlToMarkdown("<p>a ~ b</p>"))).toBe("<p>a ~ b</p>");
  expect(markdownToHtml(htmlToMarkdown("<p><code>~/.ssh</code></p>"))).toContain("<code>~/.ssh</code>");
  expect(markdownToHtml(htmlToMarkdown("<p>月~金、土~日</p>"))).not.toContain("<s>");
  expect(markdownToHtml(htmlToMarkdown("<p>~~二重~~</p>"))).not.toContain("<s>");
});

test("文字だったものは、変換後も同じ文字のまま残る", () => {
  const samples = [
    "<p>&lt;div&gt; と a_b</p>",
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    "<p>1. 番号ではない</p>",
    "<p>1) 番号ではない</p>",
    "<p>&amp;amp;</p>",
    "<p>a | b<br>--- | ---</p>",
    "<p># 見出しではない</p>",
    "<p>- リストではない</p>",
    "<p>+ 項目ではない</p>",
    "<p>* 項目ではない</p>",
    "<p>&gt; 引用ではない</p>",
    "<p>```</p>",
    "<p>~~~</p>",
    "<p>---</p>",
    "<p>===</p>",
    "<p>題<br>===</p>",
    "<p>題<br>---</p>",
    "<p>[^1]</p>",
    "<blockquote><p>[!NOTE]</p></blockquote>",
    "<p>    字下げ</p>",
    "<p>a\nb</p>",
    '<a href="/a?x=1&amp;y=2">x</a>',
    "<pre><code>&lt;div&gt;</code></pre>",
    '<pre><code class="language-html">&lt;div class="x"&gt;a&lt;/div&gt;</code></pre>',
    "<p><code>&lt;div&gt;</code></p>",
    "<p><code>a``b</code></p>",
    "<p><code>`x`</code> 後</p>",
    "<p><strong>#</strong> と</p>",
    "<p><em>-</em> と</p>",
    "<p>月~金、土~日</p>",
    "<p>~~二重~~</p>",
    "<p>a ~ b</p>",
    "<p><code>~/.ssh</code></p>",
    // Tiptap（StarterKit・TaskList）が出す形
    "<p>段落です</p>",
    "<p>1行目<br>2行目</p>",
    "<h1>見出し1</h1>",
    "<h2>見出し2</h2>",
    "<h3>見出し3</h3>",
    "<p><strong>太字</strong> と <em>斜体</em> と <s>取消</s> と <code>code</code></p>",
    '<pre><code class="language-ts">const a = 1;</code></pre>',
    "<blockquote><p>引用です</p></blockquote>",
    "<ul><li><p>項目</p></li><li><p>次</p></li></ul>",
    "<ul><li><p>親</p><ul><li><p>子</p></li></ul></li></ul>",
    "<ol><li><p>いち</p></li><li><p>に</p></li></ol>",
    '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>済み</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>未</p></div></li></ul>',
    '<p><a href="https://example.com" rel="noopener noreferrer" target="_blank">リンク</a></p>',
    "<hr>",
    "<p></p>",
    '<h2>見出し</h2><p>これは <strong>太字</strong> と <code>code</code> です</p><ul><li><p>項目</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>済み</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>未</p></div></li></ul><blockquote><p>引用</p></blockquote><p><a href="https://example.com">Sen</a></p>',
  ];

  for (const html of samples) {
    const md = htmlToMarkdown(html);
    const back = markdownToHtml(md);
    expect(markdownToText(md), html).toBe(htmlVisibleText(html));
    expect(back, html).not.toContain("md-raw-html");
    if (!/<table\b/i.test(html)) expect(back, html).not.toContain("<table");
    expect(tagCount(back, /<h[1-6]\b/gi), html).toBe(tagCount(html, /<h[1-6]\b/gi));
    expect(tagCount(back, /<(?:ul|ol)\b/gi), html).toBe(tagCount(html, /<(?:ul|ol)\b/gi));
    expect(tagCount(back, /<blockquote\b/gi), html).toBe(tagCount(html, /<blockquote\b/gi));
  }
});
