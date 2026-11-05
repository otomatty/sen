import { expect, test } from "@playwright/test";
import { MARKDOWN_MAX_LENGTH } from "../../shared/constants";
import {
  ALERT_LABELS,
  ALERT_TYPES,
  createMarked,
  isMarkdownBlank,
  markdownTextCacheSize,
  markdownToHtml,
  markdownToPlainLines,
  markdownToText,
  matchAlert,
  matchFootnoteDefinition,
  matchFootnoteReference,
  matchInlineHtml,
} from "../../shared/markdown";

test("注記・脚注・行内 HTML の判定", () => {
  expect(ALERT_TYPES).toEqual(["note", "tip", "important", "warning", "caution"]);
  expect(ALERT_LABELS).toEqual({ note: "メモ", tip: "ヒント", important: "重要", warning: "警告", caution: "注意" });

  expect(matchAlert("> [!NOTE]\n> hello\n")).toEqual({ raw: "> [!NOTE]\n> hello\n", type: "note", body: "hello" });
  expect(matchAlert("> [!Tip]\n> a\n")?.type).toBe("tip");
  expect(matchAlert(">[!IMPORTANT]\n")).toEqual({ raw: ">[!IMPORTANT]\n", type: "important", body: "" });
  expect(matchAlert("   > [!WARNING]\n> x\n")).toEqual({ raw: "   > [!WARNING]\n> x\n", type: "warning", body: "x" });
  expect(matchAlert("> [!caution]   \n")?.type).toBe("caution");
  expect(matchAlert("> [!NOTE]\n> hello\n> world\n\nnext")).toEqual({
    raw: "> [!NOTE]\n> hello\n> world\n",
    type: "note",
    body: "hello\nworld",
  });
  expect(matchAlert("> [!NOTE]\n>hello\n>  hello\n")).toEqual({
    raw: "> [!NOTE]\n>hello\n>  hello\n",
    type: "note",
    body: "hello\n hello",
  });
  expect(matchAlert("> [!FOO]\n")).toBeNull();
  expect(matchAlert("> [!NOTE] extra\n")).toBeNull();
  expect(matchAlert(">  [!NOTE]\n")).toBeNull();
  expect(matchAlert("    > [!NOTE]\n")).toBeNull();
  expect(matchAlert("前置き\n> [!NOTE]\n")).toBeNull();

  const footnote = "[^1]: 一行目\n    続き\n\n    さらに\n\n本文";
  expect(matchFootnoteDefinition(footnote)).toEqual({
    raw: "[^1]: 一行目\n    続き\n\n    さらに\n",
    label: "1",
    body: "一行目\n続き\n\nさらに",
  });
  expect(matchFootnoteDefinition("[^a]: t\n\tindented\n")).toEqual({
    raw: "[^a]: t\n\tindented\n",
    label: "a",
    body: "t\nindented",
  });
  expect(matchFootnoteDefinition("[^1]:hello\n")?.body).toBe("hello");
  expect(matchFootnoteDefinition("[a]: https://example.com\n")).toBeNull();
  expect(matchFootnoteDefinition("    [^1]: x\n")).toBeNull();
  expect(matchFootnoteDefinition("本文 [^1]: 続き")).toBeNull();

  expect(matchFootnoteReference("[^abc]")).toEqual({ raw: "[^abc]", label: "abc" });
  expect(matchFootnoteReference("[^1]:")).toEqual({ raw: "[^1]", label: "1" });
  expect(matchFootnoteReference("[^a b]")).toBeNull();
  expect(matchFootnoteReference("x[^1]")).toBeNull();

  expect(matchInlineHtml("<br>")).toEqual({ raw: "<br>" });
  expect(matchInlineHtml("<br/>")).toEqual({ raw: "<br/>" });
  expect(matchInlineHtml("<a  />")).toEqual({ raw: "<a  />" });
  expect(matchInlineHtml('<a href="x">')).toEqual({ raw: '<a href="x">' });
  expect(matchInlineHtml("<a href='x'>")).toEqual({ raw: "<a href='x'>" });
  expect(matchInlineHtml("</a>")).toEqual({ raw: "</a>" });
  expect(matchInlineHtml("<img src=x onerror=alert(1)>")).toEqual({ raw: "<img src=x onerror=alert(1)>" });
  expect(matchInlineHtml("<script>alert(1)</script>")?.raw).toBe("<script>");
  expect(matchInlineHtml("<!-- hi -->")).toEqual({ raw: "<!-- hi -->" });
  expect(matchInlineHtml("<!-->")).toEqual({ raw: "<!-->" });
  expect(matchInlineHtml("<!--->")).toEqual({ raw: "<!--->" });
  expect(matchInlineHtml("<!---->")).toEqual({ raw: "<!---->" });
  expect(matchInlineHtml("<!-- -- -->")).toEqual({ raw: "<!-- -- -->" });
  expect(matchInlineHtml("<?php ?>")).toEqual({ raw: "<?php ?>" });
  expect(matchInlineHtml("<!DOCTYPE html>")).toEqual({ raw: "<!DOCTYPE html>" });
  expect(matchInlineHtml("<![CDATA[>&<]]>")).toEqual({ raw: "<![CDATA[>&<]]>" });
  expect(matchInlineHtml('<b2\ndata="foo" >')).toEqual({ raw: '<b2\ndata="foo" >' });
  expect(matchInlineHtml("<https://example.com>")).toBeNull();
  expect(matchInlineHtml("<a@example.com>")).toBeNull();
  expect(matchInlineHtml("<33>")).toBeNull();
  expect(matchInlineHtml("<__>")).toBeNull();
  expect(matchInlineHtml("a<br>")).toBeNull();
});

test("注記は引用より先、脚注定義はリンクの参照定義より先に判定される", () => {
  const marked = createMarked();
  expect(marked.lexer("> [!NOTE]\n> 本文")[0]?.type).toBe("alert");
  expect(marked.lexer("[^1]: 本文")[0]?.type).toBe("footnoteDefinition");
  expect(marked.lexer("[a]: https://example.com")[0]?.type).toBe("def");
  // 本文は Markdown のまま残る。GFM の自動リンクになっても、参照定義として消えはしない。
  const footnoteUrl = markdownToHtml("[^1]: https://example.com");
  expect(footnoteUrl).toContain('class="md-footnote"');
  expect(footnoteUrl).toContain("https://example.com");
  expect(markdownToText("[^1]: https://example.com")).toBe("https://example.com");
  expect(markdownToHtml("[a]: https://example.com\n\n[a]")).toBe('<p><a href="https://example.com">a</a></p>');
});

test("markdownToText は検索に使う文字だけを残す", () => {
  expect(markdownToText("# 見出し")).toBe("見出し");
  expect(markdownToText("これは **太字** *斜体* ~~消~~ `code` です")).toBe("これは 太字 斜体 消 code です");
  expect(markdownToText("> 引用")).toBe("引用");
  expect(markdownToText("> [!NOTE]\n> 注記本文")).toBe("注記本文");
  expect(markdownToText("> [!WARNING]\n> > [!TIP]\n> > 内側")).toBe("内側");
  expect(markdownToText("- 項目1\n- 項目2")).toBe("項目1 項目2");
  expect(markdownToText("[^1]: 一行目\n    続き\n\n    さらに")).toBe("一行目 続き さらに");
  expect(markdownToText("前[^1]後")).toBe("前後");
  expect(markdownToText("see [^1] now")).toBe("see now");
  expect(markdownToText("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe("A B 1 2");
  expect(markdownToText("```\ncode block\n```")).toBe("code block");
  expect(markdownToText("[文字](https://secret.example/path)")).toBe("文字");
  expect(markdownToText("![代替](https://secret.example/a.png)")).toBe("代替");
  expect(markdownToText("<div>タグの中</div>")).toBe("タグの中");
  expect(markdownToText("a <!-- x --> b")).toBe("a b");
  expect(markdownToText("<!-- メモ -->")).toBe("");
  // 生の HTML はソースのまま。タグを除くと &amp; が残る（末尾でまとめて戻していた頃は & だった）。
  expect(markdownToText("<div>&amp;</div>")).toBe("&amp;");
  expect(markdownToText("A &amp; B &lt; C &gt; D &quot; E &#39; F &apos; G &#123; H &#x1F600;")).toBe('A & B < C > D " E \' F \' G { H 😀');
  expect(markdownToText("a&nbsp;&nbsp;b")).toBe("a b");
  expect(markdownToText("a&nbsp;&nbsp;b").includes("\u00A0")).toBe(false);
  expect(markdownToText("a\n\n  b")).toBe("a b");
  expect(markdownToText("a\nb")).toBe("a b");
  expect(markdownToText("  a  ")).toBe("a");
  expect(markdownToText("hello @taro")).toBe("hello @taro");
  expect(markdownToText("hi [@taro](https://e.com/u)")).toBe("hi @taro");
  expect(markdownToText("use `@taro`")).toBe("use @taro");
  expect(markdownToText("hello @taro")).toBe(markdownToText("hello @taro"));
});

test("markdownToPlainLines はブロックの区切りを改行で残す", () => {
  expect(markdownToPlainLines("段落1\n\n段落2")).toBe("段落1\n段落2");
  expect(markdownToPlainLines("- 項目1\n- 項目2")).toBe("項目1\n項目2");
  expect(markdownToPlainLines("# 見出し")).toBe("見出し");
  expect(markdownToPlainLines("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe("A | B\n1 | 2");
  expect(markdownToPlainLines("a\nb")).toBe("a\nb");
  expect(markdownToPlainLines("```\ncode1\ncode2\n```")).toBe("code1\ncode2");
  expect(markdownToPlainLines("[文字](https://secret.example/path)")).toBe("文字");
  expect(markdownToPlainLines("<div>タグの中</div>")).toBe("タグの中");
  expect(markdownToPlainLines("<div>&amp;</div>")).toBe("&amp;");
});

test("isMarkdownBlank は文字も画像も水平線も無いときだけ真", () => {
  expect(isMarkdownBlank("")).toBe(true);
  expect(isMarkdownBlank("  \n")).toBe(true);
  expect(isMarkdownBlank("<!-- メモ -->")).toBe(true);
  expect(isMarkdownBlank("![図](https://e.com/a.png)")).toBe(false);
  expect(isMarkdownBlank("![](https://e.com/a.png)")).toBe(false);
  expect(isMarkdownBlank("![](/image.png)")).toBe(true);
  expect(isMarkdownBlank("![](javascript:alert(1))")).toBe(true);
  expect(isMarkdownBlank("![](data:image/png;base64,AAAA)")).toBe(true);
  expect(isMarkdownBlank("![図](/a.png)")).toBe(false);
  expect(isMarkdownBlank("---")).toBe(false);
  expect(isMarkdownBlank("a")).toBe(false);
});

test("平文は、表示が文字参照を戻す所だけ戻す", () => {
  const samples: [string, string][] = [
    ["`&amp;` と &amp;", "&amp; と &"],
    ["```\n&lt;div&gt;\n```", "&lt;div&gt;"],
    ["[a &amp; b](https://e.com)", "a & b"],
    ["# A &amp; B", "A & B"],
    ["![a &amp; b](https://e.com/x.png)", "a & b"],
    ["\\&amp;", "&amp;"],
    ["<kbd>&amp;</kbd>", "&"],
    ["a <b>&#64;Alice</b> b", "a @Alice b"],
  ];
  for (const [md, text] of samples) {
    expect(markdownToText(md), md).toBe(text);
    expect(markdownToPlainLines(md), md).toBe(text);
  }
});

test("markdownToHtml は構文を安全な HTML にする", () => {
  expect(markdownToHtml("")).toBe("");
  expect(markdownToHtml("   \n")).toBe("");
  expect(markdownToHtml("# a\n## b\n### c\n#### d\n##### e\n###### f")).toBe("<h1>a</h1>\n<h2>b</h2>\n<h3>c</h3>\n<h4>d</h4>\n<h5>e</h5>\n<h6>f</h6>");
  expect(markdownToHtml("これは **太字** *斜体* ~~取消~~ `code` です")).toBe("<p>これは <strong>太字</strong> <em>斜体</em> <s>取消</s> <code>code</code> です</p>");
  expect(markdownToHtml("```ts\nconst a = 1;\n```")).toBe('<pre><code class="language-ts">const a = 1;\n</code></pre>');
  expect(markdownToHtml("```c++\n++i;\n```")).toBe('<pre><code class="language-c++">++i;\n</code></pre>');
  expect(markdownToHtml("```\ncode\n```")).toBe("<pre><code>code\n</code></pre>");
  expect(markdownToHtml("> 引用です")).toBe("<blockquote>\n<p>引用です</p>\n</blockquote>");
  expect(markdownToHtml("- 親\n  - 子\n- 次")).toBe("<ul>\n<li>親<ul>\n<li>子</li>\n</ul></li>\n<li>次</li>\n</ul>");
  expect(markdownToHtml("1. 一\n2. 二")).toBe("<ol>\n<li>一</li>\n<li>二</li>\n</ol>");
  expect(markdownToHtml("3. 三")).toBe('<ol start="3">\n<li>三</li>\n</ol>');
  expect(markdownToHtml("a  \nb")).toBe("<p>a<br>b</p>");
  expect(markdownToHtml("a\nb")).toBe("<p>a<br>b</p>");
  expect(markdownToHtml("---")).toBe("<hr>");
  expect(markdownToHtml("- [x] 済み\n- [ ] 未")).toBe(
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked disabled></label><div><p>済み</p></div></li><li data-type="taskItem" data-checked="false"><label><input type="checkbox" disabled></label><div><p>未</p></div></li></ul>',
  );
  expect(markdownToHtml("- a\n- [x] b\n- c")).toBe(
    '<ul>\n<li>a</li>\n</ul>\n<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked disabled></label><div><p>b</p></div></li></ul>\n<ul>\n<li>c</li>\n</ul>',
  );
  expect(markdownToHtml("1. a\n2. [x] b\n3. c")).toBe(
    '<ol>\n<li>a</li>\n</ol>\n<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked disabled></label><div><p>b</p></div></li></ul>\n<ol start="3">\n<li>c</li>\n</ol>',
  );
  expect(markdownToHtml("[Sen](https://example.com)")).toBe('<p><a href="https://example.com">Sen</a></p>');
  expect(markdownToHtml("[a](mailto:a@b.c)")).toBe('<p><a href="mailto:a@b.c">a</a></p>');
  expect(markdownToHtml("[a](/docs)")).toBe('<p><a href="/docs">a</a></p>');
  expect(markdownToHtml("[a](#goal)")).toBe('<p><a href="#goal">a</a></p>');
  expect(markdownToHtml("[検索](/search?a=1&amp;b=2)")).toBe('<p><a href="/search?a=1&amp;b=2">検索</a></p>');
  expect(markdownToHtml("[検索](/search?a=1&b=2)")).toBe('<p><a href="/search?a=1&amp;b=2">検索</a></p>');
  expect(markdownToHtml('![図](https://e.com/a.png "題")')).toBe('<p><img src="https://e.com/a.png" alt="図" title="題"></p>');
  expect(markdownToHtml("![図](http://e.com/a.png)")).toBe('<p><img src="http://e.com/a.png" alt="図"></p>');
  expect(markdownToHtml("![図](/a.png)")).toBe("<p>図</p>");
  expect(markdownToHtml("| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |")).toBe(
    '<table>\n<thead>\n<tr>\n<th data-align="left">a</th>\n<th data-align="center">b</th>\n<th data-align="right">c</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td data-align="left">1</td>\n<td data-align="center">2</td>\n<td data-align="right">3</td>\n</tr>\n</tbody>\n</table>',
  );
  expect(markdownToHtml("| a | b |\n| --- | --- |")).toBe("<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n</table>");
  expect(markdownToHtml("> [!NOTE]\n> 本文")).toBe('<div class="md-alert" data-alert="note" data-alert-label="メモ">\n<p>本文</p>\n</div>');
  expect(markdownToHtml("> [!TIP]\n> t")).toContain('data-alert="tip"');
  expect(markdownToHtml("> [!IMPORTANT]\n> i")).toContain('data-alert-label="重要"');
  expect(markdownToHtml("> [!WARNING]\n> w")).toContain('data-alert-label="警告"');
  expect(markdownToHtml("> [!CAUTION]\n> c")).toContain('data-alert-label="注意"');
  expect(markdownToHtml("> [!NOTE]\n> 本文")).not.toContain("<blockquote>");
  expect(markdownToHtml("[^1]: 本文")).toBe('<div class="md-footnote" data-label="1">\n<p>本文</p>\n</div>');
  expect(markdownToHtml("see [^1]")).toBe('<p>see <sup class="md-footnote-ref" data-label="1">1</sup></p>');
  expect(markdownToHtml("<script>alert(1)</script>")).toBe('<pre class="md-raw-html"><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
  expect(markdownToHtml("<div>a</div>\n\n\n")).toBe('<pre class="md-raw-html"><code>&lt;div&gt;a&lt;/div&gt;</code></pre>');
  expect(markdownToHtml("foo <em>x</em> bar")).toBe('<p>foo <code class="md-raw-html">&lt;em&gt;</code>x<code class="md-raw-html">&lt;/em&gt;</code> bar</p>');
  expect(markdownToHtml("<!-- メモ -->")).toBe('<pre class="md-raw-html"><code>&lt;!-- メモ --&gt;</code></pre>');
});

test("危険な HTML と URL はタグにならない", () => {
  const script = markdownToHtml("<script>alert(1)</script>");
  expect(script).not.toContain("<script");
  expect(script).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

  const img = markdownToHtml("<img src=x onerror=alert(1)>");
  expect(img).not.toMatch(/<img[\s>]/i);
  expect(img).toContain("&lt;img src=x onerror=alert(1)&gt;");

  const js = markdownToHtml("[x](javascript:alert(1))");
  expect(js).toBe("<p>x</p>");
  expect(js).not.toContain("<a");
  expect(js).not.toContain("javascript:");
  expect(markdownToHtml("[x](&#106;avascript:alert(1))")).toBe("<p>x</p>");
  expect(markdownToHtml("[x](javascript&#58;alert(1))")).toBe("<p>x</p>");

  const badImg = markdownToHtml("![x](javascript:alert(1))");
  expect(badImg).toBe("<p>x</p>");
  expect(badImg).not.toContain("<img");
  expect(badImg).not.toContain("javascript:");

  const dataImg = markdownToHtml("![x](data:image/png;base64,AAAA)");
  expect(dataImg).toBe("<p>x</p>");
  expect(dataImg).not.toContain("data:");
  expect(dataImg).not.toContain("<img");

  expect(markdownToHtml('![a"b](https://e.com/a.png "t\\"i")')).toBe('<p><img src="https://e.com/a.png" alt="a&quot;b" title="t&quot;i"></p>');
  expect(markdownToHtml("![a'b](https://e.com/a.png \"say 'hi'\")")).toBe('<p><img src="https://e.com/a.png" alt="a&#39;b" title="say &#39;hi&#39;"></p>');
  expect(markdownToHtml('[a](<https://e.com/?q=">)')).toBe('<p><a href="https://e.com/?q=&quot;">a</a></p>');
  expect(markdownToHtml('[^a"><img]: x')).toBe('<div class="md-footnote" data-label="a&quot;&gt;&lt;img">\n<p>x</p>\n</div>');

  const evilLang = markdownToHtml('```"><img src=x onerror=alert(1)>\nalert\n```');
  expect(evilLang).not.toContain("<img");
  expect(evilLang).not.toContain("onerror");
  expect(evilLang).toContain('class="language-img"');
});

test("各構文は例外なく HTML になり、65,536 文字でも 1 秒以内", () => {
  const samples = [
    "# 見出し",
    "段落 **太字** *斜体* ~~消~~ `code`",
    "```ts\nconst a = 1;\n```",
    "> 引用",
    "> [!NOTE]\n> 注記",
    "> [!TIP]\n> a",
    "> [!IMPORTANT]\n> a",
    "> [!WARNING]\n> a",
    "> [!CAUTION]\n> a",
    "- 項目\n  - 子",
    "1. 一",
    "- [x] 済み\n- [ ] 未",
    "- 普通\n- [x] 済",
    "[文字](https://example.com)",
    "![図](https://e.com/a.png)",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "[^1]: 本文\n    続き",
    "参照 [^1]",
    "<https://example.com>",
    "<a@example.com>",
    "<script>alert(1)</script>",
    "foo <em>x</em> bar",
    "<!-- メモ -->",
    "a  \nb",
    "---",
    "hello @taro",
    "A &amp; B",
  ];
  for (const sample of samples) expect(() => markdownToHtml(sample)).not.toThrow();

  expect(MARKDOWN_MAX_LENGTH).toBe(65_536);
  const unit = "本文 **太字** [リンク](https://example.com) `code`\n\n";
  const md = unit.repeat(Math.ceil(MARKDOWN_MAX_LENGTH / unit.length)).slice(0, MARKDOWN_MAX_LENGTH);
  expect(md.length).toBe(65_536);
  const started = Date.now();
  const html = markdownToHtml(md);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(html.length).toBeGreaterThan(1000);
});

test("平文のキャッシュは、長い文字列を重ねても文字数の合計が 400 万を超えない", () => {
  const before = markdownTextCacheSize();
  markdownToText("あ".repeat(100_001));
  expect(markdownTextCacheSize()).toEqual(before);

  const piece = "x".repeat(40_000);
  for (let i = 0; i < 150; i++) markdownToText(`${piece} ${i}`);
  const after = markdownTextCacheSize();
  expect(after.entries).toBeLessThanOrEqual(2000);
  expect(after.entries).toBeGreaterThan(0);
  expect(after.chars).toBeLessThanOrEqual(4_000_000);
  expect(after.chars).toBeGreaterThan(3_000_000);
});
