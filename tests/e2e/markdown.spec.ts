import { expect, test } from "@playwright/test";
import { markdownToHtml, markdownToText } from "../../shared/markdown";
import { htmlToMarkdown, htmlToMarkdownChecked } from "../../worker/markdown";

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
  expect(back).toBe(["## 見出し", "- 親", "  - 子", "* [x] 済み", "* [ ] 未", "", "```ts", "const a = 1;", "```", "", "[Sen](https://example.com)"].join("\n"));
  expect(back).toContain("## 見出し");
  expect(back).toContain("  - 子");
  expect(back).toContain("* [x] 済み");
  expect(back).toContain("* [ ] 未");
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

test("リンク先の文字参照に見える並びは、もう一度戻されない", async ({ page }) => {
  const read = async (html: string) => {
    await page.setContent(html);
    const a = page.locator("a");
    return { href: await a.getAttribute("href"), text: await a.textContent() };
  };

  const cases = [
    '<a href="https://example.com/?q=&amp;copy;">link</a>',
    '<a href="https://example.com/?q=&amp;copy;">https://example.com/?q=&amp;copy;</a>',
    '<a href="https://example.com/?x=&amp;#169;">link</a>',
  ];
  for (const html of cases) {
    const original = await read(html);
    const back = await read(markdownToHtml(htmlToMarkdown(html)));
    expect(back.href, html).toBe(original.href);
    expect(back.text, html).toBe(original.text);
  }

  const query = '<a href="https://example.com/?a=1&amp;b=2">link</a>';
  expect(htmlToMarkdown(query)).toBe("[link](https://example.com/?a=1&b=2)");
  expect((await read(markdownToHtml(htmlToMarkdown(query)))).href).toBe("https://example.com/?a=1&b=2");
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

test("強調の端の空白と句読点は区切りの外に出て、太字・斜体・取消のまま残る", () => {
  const cases = [
    { html: "<strong>foo </strong>bar", tag: "<strong>" },
    { html: "<em> foo</em>", tag: "<em>" },
    { html: "a<strong> b </strong>c", tag: "<strong>" },
    { html: "<strong>重要。</strong>次に", tag: "<strong>" },
    { html: "<strong>「重要」</strong>です", tag: "<strong>" },
    { html: "前<strong>(注)</strong>後", tag: "<strong>" },
    { html: '<strong><a href="https://example.com">link</a></strong>です', tag: "<strong>" },
    // 取消線の表示は <s>（~~ の描画）。入力の <del> が強調のまま残ることを見る。
    { html: "<del>「取消」</del>です", tag: "<s>" },
  ];
  for (const { html, tag } of cases) {
    const md = htmlToMarkdown(html);
    const back = markdownToHtml(md);
    expect(back, html).toContain(tag);
    expect(markdownToText(md), html).toBe(htmlVisibleText(html));
    expect(back, html).not.toContain("md-raw-html");
    if (!/<table\b/i.test(html)) expect(back, html).not.toContain("<table");
    expect(tagCount(back, /<h[1-6]\b/gi), html).toBe(tagCount(html, /<h[1-6]\b/gi));
    expect(tagCount(back, /<(?:ul|ol)\b/gi), html).toBe(tagCount(html, /<(?:ul|ol)\b/gi));
    expect(tagCount(back, /<blockquote\b/gi), html).toBe(tagCount(html, /<blockquote\b/gi));
  }
});

test("重ねた強調の端の句読点は、外側の隣を見て区切りの外に出る", () => {
  const cases = ['<strong><em>「両方」</em></strong>です', "前<em><strong>(注)</strong></em>後", '<strong>「<em>両方</em>」</strong>です'];
  for (const html of cases) {
    const md = htmlToMarkdown(html);
    const back = markdownToHtml(md);
    expect(back, html).toContain("<strong>");
    expect(back, html).toContain("<em>");
    expect(markdownToText(md), html).toBe(htmlVisibleText(html));
  }
  expect(htmlToMarkdown('<strong><em>「両方」</em></strong>です')).toBe("「***両方***」です");
  expect(htmlToMarkdown("前<em><strong>(注)</strong></em>後")).toBe("前(***注***)後");
  expect(htmlToMarkdown('<strong>「<em>両方</em>」</strong>です')).toBe("「***両方***」です");
});

test("リンクの端の空白は記法の外に出て、単語はつながらない", () => {
  const cases = [
    '<p>before<a href="https://example.com"> link </a>after</p>',
    '<p>a<a href="https://example.com"> https://example.com </a>b</p>',
    '<p>a<strong><a href="https://example.com"> link </a></strong>b</p>',
    '<p><a href="https://example.com">link </a>after</p>',
  ];
  for (const html of cases) {
    const md = htmlToMarkdown(html);
    const back = markdownToHtml(md);
    expect(htmlVisibleText(back), `${html} => ${md}`).toBe(htmlVisibleText(html));
    expect(back, md).toContain('href="https://example.com"');
  }
  expect(htmlToMarkdown('<p>before<a href="https://example.com"> link </a>after</p>')).toBe("before [link](https://example.com) after");
  expect(htmlToMarkdown('<p>a<a href="https://example.com"> https://example.com </a>b</p>')).toBe("a <https://example.com> b");
  expect(htmlToMarkdown('<p>a<strong><a href="https://example.com"> link </a></strong>b</p>')).toBe("a [**link**](https://example.com) b");
  expect(htmlToMarkdown('<p><a href="https://example.com">link </a>after</p>')).toBe("[link](https://example.com) after");
  expect(htmlVisibleText(markdownToHtml(htmlToMarkdown("<p>a<a> x </a>b</p>")))).toBe("a x b");
});

test("プロトタイプの名前は文字のまま残り、関数にはならない", () => {
  const md = htmlToMarkdown("<p>&constructor; &toString;</p>");
  const shown = markdownToHtml(md);
  expect(shown).not.toContain("function");
  expect(htmlVisibleText(shown)).toBe("&constructor; &toString;");
  const direct = markdownToHtml("&constructor; &toString; &valueOf; &hasOwnProperty;");
  expect(direct).not.toContain("function");
});

test("名前付きの文字参照は1回だけ戻して表示する", () => {
  expect(markdownToText(htmlToMarkdown("<p>&copy; 2026 &eacute;t&eacute;</p>"))).toBe("© 2026 été");
  expect(markdownToHtml(htmlToMarkdown("<p>&copy; 2026 &eacute;t&eacute;</p>"))).toBe("<p>© 2026 été</p>");
  expect(markdownToText(htmlToMarkdown("<p>&amp;copy;</p>"))).toBe("&copy;");
  expect(markdownToHtml(htmlToMarkdown("<p>&amp;copy;</p>"))).toBe("<p>&amp;copy;</p>");
  expect(markdownToText(htmlToMarkdown("<p>&foo;</p>"))).toBe("&foo;");
  expect(markdownToHtml(htmlToMarkdown("<p>&foo;</p>"))).toBe("<p>&amp;foo;</p>");
});

test("大文字の基本の文字参照は戻し、ほかの名前は大文字小文字を区別する", () => {
  const md = htmlToMarkdown("<p>&AMP; &LT;b&GT; &QUOT;</p>");
  expect(markdownToText(md)).toBe('& <b> "');
  const back = markdownToHtml(md);
  expect(back).toBe('<p>&amp; &lt;b&gt; &quot;</p>');
  expect(back).not.toContain("<b>");
  expect(markdownToText(htmlToMarkdown("<p>&Eacute;</p>"))).toBe("É");
  expect(markdownToHtml(htmlToMarkdown("<p>&Eacute;</p>"))).toBe("<p>É</p>");
  expect(markdownToText(htmlToMarkdown("<p>&eacute;</p>"))).toBe("é");
  expect(markdownToHtml(htmlToMarkdown("<p>&eacute;</p>"))).toBe("<p>é</p>");
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
    // 段落のすぐ後ろのリスト。1 以外の番号は空行がないと段落に飲み込まれる。
    '<p>Steps</p><ol start="3"><li><p>third</p></li></ol>',
    '<p>Steps</p><ol start="1"><li><p>first</p></li></ol>',
    "<p>Steps</p><ul><li><p>item</p></li></ul>",
    '<p>Steps</p><ul data-type="taskList"><li data-checked="false" data-type="taskItem"><label><input type="checkbox"></label><div><p>todo</p></div></li></ul>',
    // 見出し末尾の「空白 + #」は閉じ記号にしない。C# のように空白が無い # はそのまま。
    "<h2>Language #</h2>",
    "<h1>A ##</h1>",
    "<h3>C# と F#</h3>",
    "<h2>#1</h2>",
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
    const checked = htmlToMarkdownChecked(html);
    expect(checked.fallback, html).toBe(false);
    expect(checked.markdown, html).toBe(md);
  }
});

test("隣り合う同じ書式は1つにまとまり、表示の文字と書式が残る", () => {
  const cases = [
    { html: "<p><strong>a</strong><strong>b</strong></p>", tag: "<strong>" },
    { html: "<p><em>a</em><em>b</em></p>", tag: "<em>" },
    { html: "<p><code>a</code><code>b</code></p>", tag: "<code>" },
    { html: "<p><s>a</s><del>b</del></p>", tag: "<s>" },
    { html: "<p><strong>a</strong><b>b</b></p>", tag: "<strong>" },
  ];
  for (const { html, tag } of cases) {
    const back = markdownToHtml(htmlToMarkdown(html));
    expect(htmlVisibleText(back), html).toBe("ab");
    expect(back, html).toContain(tag);
  }
  const mixed = markdownToHtml(htmlToMarkdown("<p><em>a</em><strong>b</strong></p>"));
  expect(htmlVisibleText(mixed)).toBe("ab");
  expect(mixed).toContain("<em>");
  expect(mixed).toContain("<strong>");
});

function olStarts(html: string): string[] {
  return [...html.matchAll(/<ol\b[^>]*>/gi)].map((m) => /\bstart="(\d+)"/.exec(m[0])?.[1] ?? "1");
}

test("続けて並んだリストは別々のまま、番号も残る", () => {
  const cases = [
    "<ol><li><p>a</p></li></ol><ol><li><p>b</p></li></ol>",
    '<ol><li><p>a</p></li></ol><ol start="3"><li><p>b</p></li></ol>',
    "<ul><li><p>a</p></li></ul><ul><li><p>b</p></li></ul>",
    "<ol><li><p>a</p></li></ol><ol><li><p>b</p></li></ol><ol><li><p>c</p></li></ol>",
    "<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>",
    '<ul data-type="taskList"><li data-checked="false" data-type="taskItem"><label><input type="checkbox"></label><div><p>a</p></div></li></ul><ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"></label><div><p>b</p></div></li></ul>',
  ];
  for (const html of cases) {
    const md = htmlToMarkdown(html);
    const back = markdownToHtml(md);
    expect(tagCount(back, /<ol\b/gi), `${html}\n${md}\n${back}`).toBe(tagCount(html, /<ol\b/gi));
    expect(tagCount(back, /<ul\b/gi), `${html}\n${md}\n${back}`).toBe(tagCount(html, /<ul\b/gi));
    expect(olStarts(back), `${html}\n${md}\n${back}`).toEqual(olStarts(html));
    expect(htmlVisibleText(back), `${html}\n${md}`).toBe(htmlVisibleText(html));
    const checked = htmlToMarkdownChecked(html);
    expect(checked.fallback, html).toBe(false);
    expect(checked.markdown, html).toBe(md);
  }

  expect(htmlToMarkdown("<ol><li><p>a</p></li></ol><ol><li><p>b</p></li></ol>")).toBe("1. a\n1) b");
  expect(htmlToMarkdown('<ol><li><p>a</p></li></ol><ol start="3"><li><p>b</p></li></ol>')).toBe("1. a\n\n3) b");
  expect(htmlToMarkdown("<ul><li><p>a</p></li></ul><ul><li><p>b</p></li></ul>")).toBe("- a\n* b");
  expect(htmlToMarkdown("<ol><li><p>a</p></li></ol><ol><li><p>b</p></li></ol><ol><li><p>c</p></li></ol>")).toBe("1. a\n1) b\n1. c");
  expect(htmlToMarkdown("<ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>")).toBe("- a\n1. b");

  const nested = "<ul><li><p>親</p><ul><li><p>子</p></li></ul></li></ul><ul><li><p>次</p></li></ul>";
  const nestedMd = htmlToMarkdown(nested);
  expect(nestedMd).toBe("- 親\n  - 子\n* 次");
  const nestedBack = markdownToHtml(nestedMd);
  expect(tagCount(nestedBack, /<ul\b/gi)).toBe(tagCount(nested, /<ul\b/gi));
  expect(htmlVisibleText(nestedBack)).toBe(htmlVisibleText(nested));

  const stars = "<ul><li><p>*強調*</p></li></ul><ul><li><p>***</p></li></ul>";
  const starsMd = htmlToMarkdown(stars);
  const starsBack = markdownToHtml(starsMd);
  expect(starsMd).toBe("- \\*強調\\*\n* \\*\\*\\*");
  expect(starsBack).not.toContain("<em>");
  expect(starsBack).not.toContain("<hr");
  expect(htmlVisibleText(starsBack)).toBe("*強調* ***");
  expect(tagCount(starsBack, /<ul\b/gi)).toBe(2);
});

test("深い入れ子の HTML は例外にせず平文にする", () => {
  for (const html of ["<div>".repeat(20000) + "x", "<b>".repeat(20000) + "x"]) {
    const checked = htmlToMarkdownChecked(html);
    expect(checked.fallback).toBe(true);
    expect(markdownToText(checked.markdown)).toBe("x");
  }
});

test("直らない行内の入れ子は書式を外し、見える文字だけ残す", () => {
  const html = "<p><strong>a<code>c</code></strong>です</p>";
  const checked = htmlToMarkdownChecked(html);
  expect(checked.fallback).toBe(true);
  expect(checked.markdown).not.toContain("*");
  const back = markdownToHtml(checked.markdown);
  expect(htmlVisibleText(back)).toBe("acです");
  expect(back).not.toContain("*");
});
