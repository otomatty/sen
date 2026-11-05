// 課題の説明・プロジェクトの説明・コメントを、GitHub 互換の Markdown（GFM）の文字列で保存するための共通処理。
// GitHub の Issue・コメントと同じく、1 回の改行は改行のまま表示する（リポジトリの .md ファイルとは違う）。
// 検索・メンション・通知の抜粋に使う平文、空かどうかの判定、エディタを使わないときの表示用 HTML を作る。
// Worker とブラウザの両方で動くよう、DOM も Node の API も cloudflare:workers も使わず、marked だけを使う。

import { Marked, type RendererObject, type Token, type Tokens, type TokenizerThis } from "marked";
import { HTML4_NAMED_ENTITIES } from "./html4-entities";

export const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_LABELS: Record<AlertType, string> = {
  note: "メモ",
  tip: "ヒント",
  important: "重要",
  warning: "警告",
  caution: "注意",
};

const ALERT_TYPE_SET = new Set<string>(ALERT_TYPES);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** `\&` の &。文字参照を戻す処理が、続く `amp;` などまで一緒に戻さないようにする */
const ESCAPED_AMP = "\uE000";

/**
 * amp・lt・gt・quot・apos・nbsp と数値だけ戻す。
 * それ以外の名前は null（表示では文字参照のまま、平文では HTML 4 の表を見る）。
 * 不正な数値は元の参照文字列を返す。
 */
function decodeBasicEntity(ent: string, nbsp: string): string | null {
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
      return nbsp;
  }
  if (!e.startsWith("#")) return null;
  const hex = e.startsWith("#x");
  const cp = hex ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return `&${ent};`;
  return String.fromCodePoint(cp);
}

/** 文字参照を1回だけ戻す。nbsp は呼び出し側が空白か NBSP かを決める。HTML 4 の名前は戻さない */
function decodeEntities(s: string, nbsp: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, ent: string) => decodeBasicEntity(ent, nbsp) ?? all);
}

/**
 * 本文・リンクの文字・画像の代替テキスト・属性値。
 * 6 つの名前と数値は戻してからエスケープする。
 * それ以外の `&名前;`（`&[A-Za-z][A-Za-z0-9]{1,31};`）は `&` をエスケープせず文字参照のまま出す。
 */
function escapeText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});|[&<>"']/gi, (all, ent?: string) => {
    if (!ent) return escapeHtml(all);
    const decoded = decodeBasicEntity(ent, "\u00A0");
    if (decoded === null) return all;
    return escapeHtml(decoded);
  });
}

function isSafeHref(href: string): boolean {
  if (!href || /\s/.test(href) || /[\u0000-\u001f\u007f]/.test(href)) return false;
  return /^(https?:|mailto:|\/|#)/i.test(href);
}

function isSafeImageSrc(src: string): boolean {
  if (!src || /\s/.test(src) || /[\u0000-\u001f\u007f]/.test(src)) return false;
  return /^https?:/i.test(src);
}

interface Line {
  content: string;
  raw: string;
  next: number;
}

function readLine(src: string, index: number): Line | null {
  if (index >= src.length) return null;
  let end = index;
  while (end < src.length && src[end] !== "\n" && src[end] !== "\r") end++;
  let next = end;
  if (src[end] === "\r" && src[end + 1] === "\n") next = end + 2;
  else if (src[end] === "\n" || src[end] === "\r") next = end + 1;
  return { content: src.slice(index, end), raw: src.slice(index, next), next };
}

/** GitHub の注記。src の先頭だけを見る */
export function matchAlert(src: string): { raw: string; type: AlertType; body: string } | null {
  const first = readLine(src, 0);
  if (!first) return null;
  const marker = /^ {0,3}> ?\[!(note|tip|important|warning|caution)\][ \t]*$/i.exec(first.content);
  if (!marker) return null;
  const type = marker[1].toLowerCase();
  if (!ALERT_TYPE_SET.has(type)) return null;
  let raw = first.raw;
  let index = first.next;
  const body: string[] = [];
  while (index < src.length) {
    const line = readLine(src, index);
    if (!line || !/^ {0,3}>/.test(line.content)) break;
    body.push(line.content.replace(/^ {0,3}> ?/, ""));
    raw += line.raw;
    index = line.next;
  }
  return { raw, type: type as AlertType, body: body.join("\n") };
}

function isFootnoteIndent(content: string): boolean {
  return content.startsWith("\t") || content.startsWith("    ");
}

function dedentFootnote(content: string): string {
  if (content.startsWith("\t")) return content.slice(1);
  return content.slice(4);
}

/** `[^ラベル]: 本文`。リンクの参照定義 `[a]: url` には一致しない */
export function matchFootnoteDefinition(src: string): { raw: string; label: string; body: string } | null {
  const first = readLine(src, 0);
  if (!first) return null;
  const marker = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(first.content);
  if (!marker) return null;
  let raw = first.raw;
  let index = first.next;
  const body = [marker[2]];
  while (index < src.length) {
    const line = readLine(src, index);
    if (!line) break;
    if (isFootnoteIndent(line.content)) {
      body.push(dedentFootnote(line.content));
      raw += line.raw;
      index = line.next;
      continue;
    }
    if (!/^[ \t]*$/.test(line.content)) break;
    const blanks: Line[] = [];
    let look = index;
    let indented = false;
    while (look < src.length) {
      const peek = readLine(src, look);
      if (!peek) break;
      if (isFootnoteIndent(peek.content)) {
        indented = true;
        break;
      }
      if (!/^[ \t]*$/.test(peek.content)) break;
      blanks.push(peek);
      look = peek.next;
    }
    if (!indented) break;
    for (let n = 0; n < blanks.length; n++) body.push("");
    raw += src.slice(index, look);
    index = look;
  }
  return { raw, label: marker[1], body: body.join("\n") };
}

/** `[^ラベル]`。src の先頭だけを見る */
export function matchFootnoteReference(src: string): { raw: string; label: string } | null {
  const match = /^\[\^([^\]\s]+)\]/.exec(src);
  if (!match) return null;
  return { raw: match[0], label: match[1] };
}

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

function isTagNameChar(ch: string): boolean {
  return isAsciiLetter(ch) || (ch >= "0" && ch <= "9") || ch === "-";
}

function isAttrStart(ch: string | undefined): boolean {
  return isAsciiLetter(ch) || ch === "_" || ch === ":";
}

function isAttrChar(ch: string): boolean {
  return isAttrStart(ch) || (ch >= "0" && ch <= "9") || ch === "." || ch === "-";
}

/** 空白・タブと、改行は1つまで。`\r\n` は1つの改行 */
function skipHtmlWs(src: string, index: number): number {
  let i = index;
  let lineEndings = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (lineEndings >= 1) break;
    if (ch === "\n") {
      lineEndings++;
      i++;
      continue;
    }
    if (ch === "\r") {
      lineEndings++;
      i += src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    break;
  }
  return i;
}

function isUnquotedStop(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === '"' || ch === "'" || ch === "=" || ch === "<" || ch === ">" || ch === "`";
}

function parseAttribute(src: string, index: number): number {
  if (!isAttrStart(src[index])) return -1;
  let i = index + 1;
  while (i < src.length && isAttrChar(src[i])) i++;
  const eq = skipHtmlWs(src, i);
  if (src[eq] !== "=") return i;
  i = skipHtmlWs(src, eq + 1);
  const quote = src[i];
  if (quote === '"' || quote === "'") {
    const end = src.indexOf(quote, i + 1);
    if (end < 0) return -1;
    return end + 1;
  }
  if (i >= src.length || isUnquotedStop(src[i])) return -1;
  while (i < src.length && !isUnquotedStop(src[i])) i++;
  return i;
}

function matchTag(src: string): string | null {
  if (src[0] !== "<") return null;
  let i = 1;
  const closing = src[i] === "/";
  if (closing) i++;
  if (!isAsciiLetter(src[i])) return null;
  i++;
  while (i < src.length && isTagNameChar(src[i])) i++;
  if (closing) {
    i = skipHtmlWs(src, i);
    return src[i] === ">" ? src.slice(0, i + 1) : null;
  }
  while (i < src.length) {
    const after = skipHtmlWs(src, i);
    if (after === i) break;
    if (src[after] === ">") return src.slice(0, after + 1);
    if (src[after] === "/" && src[after + 1] === ">") return src.slice(0, after + 2);
    const next = parseAttribute(src, after);
    if (next < 0) return null;
    i = next;
  }
  if (src[i] === "/" && src[i + 1] === ">") return src.slice(0, i + 2);
  if (src[i] === ">") return src.slice(0, i + 1);
  return null;
}

function matchComment(src: string): string | null {
  if (!src.startsWith("<!--")) return null;
  if (src.startsWith("<!-->")) return "<!-->";
  if (src.startsWith("<!--->")) return "<!--->";
  const end = src.indexOf("-->", 4);
  if (end < 0) return null;
  return src.slice(0, end + 3);
}

function matchCdata(src: string): string | null {
  if (!src.startsWith("<![CDATA[")) return null;
  const end = src.indexOf("]]>", 9);
  if (end < 0) return null;
  return src.slice(0, end + 3);
}

function matchProcessing(src: string): string | null {
  if (!src.startsWith("<?")) return null;
  const end = src.indexOf("?>", 2);
  if (end < 0) return null;
  return src.slice(0, end + 2);
}

function matchDeclaration(src: string): string | null {
  if (src[0] !== "<" || src[1] !== "!" || !isAsciiLetter(src[2])) return null;
  const end = src.indexOf(">", 3);
  if (end < 0) return null;
  return src.slice(0, end + 1);
}

/** `<scheme:...>` と `<user@host>` は自動リンクなので、生の HTML にはしない */
function isAutolink(raw: string): boolean {
  if (raw.length < 3 || raw[0] !== "<" || raw[raw.length - 1] !== ">") return false;
  const inner = raw.slice(1, -1);
  if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/.test(inner)) return true;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(inner);
}

/** CommonMark の行内 HTML。src の先頭だけを見る */
export function matchInlineHtml(src: string): { raw: string } | null {
  if (!src.startsWith("<")) return null;
  let raw: string | null = null;
  if (src.startsWith("<!--")) raw = matchComment(src);
  else if (src.startsWith("<![CDATA[")) raw = matchCdata(src);
  else if (src.startsWith("<?")) raw = matchProcessing(src);
  else if (src.startsWith("<!") && isAsciiLetter(src[2])) raw = matchDeclaration(src);
  else raw = matchTag(src);
  if (!raw || isAutolink(raw)) return null;
  return { raw };
}

function tokenizeBlocks(lexer: TokenizerThis["lexer"], body: string): Token[] {
  if (!body) return [];
  const prev = lexer.state.top;
  lexer.state.top = true;
  try {
    return lexer.blockTokens(body);
  } finally {
    lexer.state.top = prev;
  }
}

function extensions() {
  return [
    {
      name: "alert",
      level: "block" as const,
      tokenizer(this: TokenizerThis, src: string) {
        const match = matchAlert(src);
        if (!match) return undefined;
        return {
          type: "alert",
          raw: match.raw,
          alert: match.type,
          tokens: tokenizeBlocks(this.lexer, match.body),
        };
      },
      renderer(this: { parser: { parse(tokens: Token[]): string } }, token: Tokens.Generic) {
        const kind = String(token.alert);
        const label = ALERT_LABELS[kind as AlertType] ?? kind;
        return wrapBlock("div", ` class="md-alert" data-alert="${escapeHtml(kind)}" data-alert-label="${escapeHtml(label)}"`, this.parser.parse(token.tokens ?? []));
      },
    },
    {
      name: "footnoteDefinition",
      level: "block" as const,
      tokenizer(this: TokenizerThis, src: string) {
        const match = matchFootnoteDefinition(src);
        if (!match) return undefined;
        return {
          type: "footnoteDefinition",
          raw: match.raw,
          label: match.label,
          tokens: tokenizeBlocks(this.lexer, match.body),
        };
      },
      renderer(this: { parser: { parse(tokens: Token[]): string } }, token: Tokens.Generic) {
        const label = escapeHtml(String(token.label ?? ""));
        return wrapBlock("div", ` class="md-footnote" data-label="${label}"`, this.parser.parse(token.tokens ?? []));
      },
    },
    {
      name: "footnoteReference",
      level: "inline" as const,
      start(src: string) {
        return src.indexOf("[^");
      },
      tokenizer(src: string) {
        const match = matchFootnoteReference(src);
        if (!match) return undefined;
        return { type: "footnoteReference", raw: match.raw, label: match.label };
      },
      renderer(token: Tokens.Generic) {
        const label = escapeHtml(String(token.label ?? ""));
        return `<sup class="md-footnote-ref" data-label="${label}">${label}</sup>`;
      },
    },
    {
      name: "inlineHtml",
      level: "inline" as const,
      start(src: string) {
        return src.indexOf("<");
      },
      tokenizer(src: string) {
        const match = matchInlineHtml(src);
        if (!match) return undefined;
        return { type: "inlineHtml", raw: match.raw, text: match.raw };
      },
      renderer(token: Tokens.Generic) {
        return `<code class="md-raw-html">${escapeHtml(String(token.raw ?? ""))}</code>`;
      },
    },
  ];
}

function wrapBlock(tag: string, attrs: string, inner: string): string {
  const body = inner.replace(/\n+$/, "");
  if (!body) return `<${tag}${attrs}></${tag}>\n`;
  return `<${tag}${attrs}>\n${body}\n</${tag}>\n`;
}

function languageClass(lang: string | undefined): string {
  const name = (lang ?? "").trim().split(/[ \t\r\n]+/)[0]?.replace(/[^A-Za-z0-9_+#-]/g, "") ?? "";
  return name ? ` class="language-${name}"` : "";
}

function taskCheckbox(checked: boolean): string {
  return checked ? `<input type="checkbox" checked disabled>` : `<input type="checkbox" disabled>`;
}

/** タスク項目の中身を、今の worker と同じくブロック（最低でも p）にする */
function taskBody(html: string): string {
  const t = html.replace(/\n+$/, "").trim();
  if (!t) return "<p></p>";
  const block = /<(?:ul|ol|p|pre|blockquote|h[1-6]|hr|div|table)\b/i.exec(t);
  if (!block) return `<p>${t}</p>`;
  if (block.index === 0) return t;
  const before = t.slice(0, block.index).trim();
  const after = t.slice(block.index);
  return before ? `<p>${before}</p>${after}` : after;
}

function renderTaskItem(parser: { parse(tokens: Token[]): string }, item: Tokens.ListItem): string {
  const checked = !!item.checked;
  const inner = taskBody(parser.parse(item.tokens));
  return `<li data-type="taskItem" data-checked="${checked}"><label>${taskCheckbox(checked)}</label><div>${inner}</div></li>`;
}

function cellHtml(parser: { parseInline(tokens: Token[]): string }, tag: "th" | "td", cell: Tokens.TableCell): string {
  const align = cell.align === "left" || cell.align === "center" || cell.align === "right" ? ` data-align="${cell.align}"` : "";
  return `<${tag}${align}>${parser.parseInline(cell.tokens)}</${tag}>\n`;
}

const renderer: RendererObject = {
  html(token) {
    const raw = token.raw || token.text || "";
    if (token.block) return `<pre class="md-raw-html"><code>${escapeHtml(raw.replace(/(?:\r?\n)+$/, ""))}</code></pre>\n`;
    return `<code class="md-raw-html">${escapeHtml(raw)}</code>`;
  },
  heading({ tokens, depth }) {
    const level = Math.min(Math.max(depth, 1), 6);
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
  },
  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  },
  blockquote({ tokens }) {
    return wrapBlock("blockquote", "", this.parser.parse(tokens));
  },
  code({ text, lang }) {
    const body = `${text.replace(/\n$/, "")}\n`;
    return `<pre><code${languageClass(lang)}>${escapeHtml(body)}</code></pre>\n`;
  },
  codespan({ text }) {
    return `<code>${escapeHtml(text)}</code>`;
  },
  hr() {
    return "<hr>\n";
  },
  br() {
    return "<br>";
  },
  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  },
  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  },
  del({ tokens }) {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  },
  link(token) {
    const text = token.tokens?.length ? this.parser.parseInline(token.tokens) : escapeText(token.text);
    const href = decodeEntities(token.href, "\u00A0");
    if (!isSafeHref(href)) return text;
    return `<a href="${escapeText(token.href)}">${text}</a>`;
  },
  image(token) {
    // 平文抽出は \& を印に置く。代替テキストでは、今まで通り & に戻してから文字参照を処理する。
    const alt = (token.tokens?.length ? inlinePlain(token.tokens) : token.text).replaceAll(ESCAPED_AMP, "&");
    const src = decodeEntities(token.href, "\u00A0");
    if (!isSafeImageSrc(src)) return escapeText(alt);
    const title = token.title ? ` title="${escapeText(token.title)}"` : "";
    return `<img src="${escapeText(token.href)}" alt="${escapeText(alt)}"${title}>`;
  },
  text(token) {
    if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
    return escapeText(token.text);
  },
  checkbox() {
    return "";
  },
  list(token) {
    // 通常の項目とタスク項目が混ざっていたら、連続するまとまりごとに別のリストへ分ける。
    const groups: { task: boolean; items: Tokens.ListItem[] }[] = [];
    for (const item of token.items) {
      const task = !!item.task;
      const last = groups[groups.length - 1];
      if (last && last.task === task) last.items.push(item);
      else groups.push({ task, items: [item] });
    }
    const ordered = token.ordered;
    let n = ordered && typeof token.start === "number" && token.start > 0 ? token.start : 1;
    let html = "";
    for (const group of groups) {
      if (group.task) {
        html += `<ul data-type="taskList">${group.items.map((item) => renderTaskItem(this.parser, item)).join("")}</ul>\n`;
      } else {
        const tag = ordered ? "ol" : "ul";
        const startAttr = ordered && n !== 1 ? ` start="${n}"` : "";
        let body = "";
        for (const item of group.items) {
          const inner = this.parser.parse(item.tokens).replace(/^\n+|\n+$/g, "");
          body += `<li>${inner}</li>\n`;
        }
        html += `<${tag}${startAttr}>\n${body}</${tag}>\n`;
      }
      if (ordered) n += group.items.length;
    }
    return html;
  },
  table(token) {
    let html = `<table>\n<thead>\n<tr>\n${token.header.map((cell) => cellHtml(this.parser, "th", cell)).join("")}</tr>\n</thead>\n`;
    if (token.rows.length) {
      const body = token.rows.map((row) => `<tr>\n${row.map((cell) => cellHtml(this.parser, "td", cell)).join("")}</tr>\n`).join("");
      html += `<tbody>\n${body}</tbody>\n`;
    }
    html += "</table>\n";
    return html;
  },
};

function buildMarked(): Marked {
  // GitHub の Issue・コメントと同じく、1 回の改行を <br> にする（.md ファイルのように 1 行にはまとめない）。
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({ extensions: extensions(), renderer });
  return marked;
}

let shared: Marked | undefined;

/** GFM。改行は GitHub の Issue・コメントと同じく <br>。注記・脚注・行内 HTML を組み込みの規則より先に試す */
export function createMarked(): Marked {
  if (!shared) shared = buildMarked();
  return shared;
}

function inlinePlain(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const token of tokens) out += inlinePiece(token);
  return out;
}

function inlinePiece(token: Token): string {
  switch (token.type) {
    case "text":
    case "codespan":
      return token.text;
    case "escape":
      return token.text === "&" ? ESCAPED_AMP : token.text;
    case "br":
      return "\n";
    case "image":
      return token.tokens?.length ? inlinePlain(token.tokens) : token.text;
    case "link":
    case "strong":
    case "em":
    case "del":
      return inlinePlain(token.tokens);
    case "html":
      return htmlToPlain(token.text);
    case "footnoteReference":
    case "checkbox":
      return "";
    default: {
      if (token.type === "inlineHtml") return htmlToPlain(token.raw);
      const children = (token as Tokens.Generic).tokens;
      if (children?.length) return inlinePlain(children);
      return typeof (token as Tokens.Generic).text === "string" ? (token as Tokens.Text).text : "";
    }
  }
}

function blocksText(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    const text = blockPiece(token);
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

function blockPiece(token: Token): string {
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
    case "checkbox":
    case "footnoteReference":
      return "";
    case "code":
    case "codespan":
      return softenNbsp(token.text);
    case "heading":
    case "paragraph":
    case "strong":
    case "em":
    case "del":
    case "link":
      return plainInline(token.tokens);
    case "blockquote":
    case "alert":
    case "footnoteDefinition":
      return blocksText((token as Tokens.Generic).tokens ?? []);
    case "list": {
      const list = token as Tokens.List;
      return list.items.map((item) => blocksText(item.tokens)).filter(Boolean).join(" ");
    }
    case "table": {
      const table = token as Tokens.Table;
      const cells = [...table.header, ...table.rows.flat()];
      return cells.map((cell) => plainInline(cell.tokens)).filter(Boolean).join(" ");
    }
    case "html":
      return htmlPlain(token.text);
    case "text":
      return token.tokens?.length ? plainInline(token.tokens) : decodePlainText(token.text);
    default:
      if (token.type === "inlineHtml") return htmlPlain(token.raw);
      return (token as Tokens.Generic).tokens ? blocksText((token as Tokens.Generic).tokens ?? []) : "";
  }
}

/** タグとコメントを取り除き、間の文字は残す */
function htmlToPlain(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[i] === "<") {
      const end = endOfTag(src, i);
      if (end > i) {
        i = end;
        continue;
      }
    }
    out += src[i];
    i++;
  }
  return out;
}

function endOfTag(src: string, index: number): number {
  let i = index + 1;
  let quote = "";
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === ">") return i + 1;
    i++;
  }
  return index;
}

/** コードと生の HTML でも、`&nbsp;` だけは従来どおり普通の空白にする */
function softenNbsp(s: string): string {
  return s.replace(/&nbsp;/gi, " ");
}

/**
 * 平文の文字参照。6 つの名前と数値に加え、HTML 4 の名前を1回だけ戻す。
 * 表に無い名前はそのまま残す。戻した改行は行を増やさないよう空白にする。
 */
function decodePlainText(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/gi, (all, ent: string) => {
      const decoded = decodeBasicEntity(ent, " ");
      if (decoded === null) return Object.hasOwn(HTML4_NAMED_ENTITIES, ent) ? HTML4_NAMED_ENTITIES[ent] : all;
      return decoded;
    })
    .replace(/[\n\r]/g, " ");
}

function htmlPlain(src: string): string {
  return softenNbsp(htmlToPlain(src));
}

/**
 * 検索・シート用の行内文字。表示が文字参照を戻す所だけ戻す。
 * 通常の文字（リンクや見出し、行内 HTML のタグの間を含む）と画像の代替テキストは戻し、コードは戻さない。
 * 行内 HTML のタグそのものは文字を残さない。
 */
function plainInline(tokens: Token[] | undefined): string {
  if (!tokens?.length) return "";
  let out = "";
  for (const token of tokens) out += plainPiece(token);
  return out;
}

function plainPiece(token: Token): string {
  switch (token.type) {
    case "text":
      if (token.tokens?.length) return plainInline(token.tokens);
      return decodePlainText(token.text);
    case "codespan":
      return softenNbsp(token.text);
    case "escape":
      return token.text === "&" ? ESCAPED_AMP : token.text;
    case "br":
      return "\n";
    case "image":
      return token.tokens?.length ? plainInline(token.tokens) : decodePlainText((token as Tokens.Image).text);
    case "link":
    case "strong":
    case "em":
    case "del":
      return plainInline(token.tokens);
    case "html":
      return htmlPlain(token.text);
    case "footnoteReference":
    case "checkbox":
      return "";
    default: {
      if (token.type === "inlineHtml") return htmlPlain(String((token as Tokens.Generic).raw ?? ""));
      const children = (token as Tokens.Generic).tokens;
      if (children?.length) return plainInline(children);
      const text = typeof (token as Tokens.Generic).text === "string" ? (token as Tokens.Text).text : "";
      return decodePlainText(text);
    }
  }
}

function hasImageOrRule(tokens: Token[]): boolean {
  for (const token of tokens) {
    if (token.type === "hr") return true;
    // 表示と同じく、src の文字参照を戻したあと http(s) の画像だけを中身とみなす。
    if (token.type === "image" && isSafeImageSrc(decodeEntities((token as Tokens.Image).href, "\u00A0"))) return true;
    if (token.type === "list") {
      const list = token as Tokens.List;
      if (list.items.some((item) => hasImageOrRule(item.tokens))) return true;
      continue;
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      const cells = [...table.header, ...table.rows.flat()];
      if (cells.some((cell) => hasImageOrRule(cell.tokens))) return true;
      continue;
    }
    const children = (token as Tokens.Generic).tokens;
    if (children && hasImageOrRule(children)) return true;
  }
  return false;
}

const textCache = new Map<string, string>();
const TEXT_CACHE_LIMIT = 2000;
/** キーと結果の長さの合計。Worker はリクエストをまたいで残るので、件数だけでは 128MB を超えうる */
const TEXT_CACHE_MAX_CHARS = 4_000_000;
/** これを超える 1 件は覚えない（キーと結果の長さの合計） */
const TEXT_CACHE_MAX_ENTRY = 100_000;
let textCacheChars = 0;

function dropOldestText(): void {
  const oldest = textCache.keys().next().value;
  if (oldest === undefined) return;
  const value = textCache.get(oldest) ?? "";
  textCache.delete(oldest);
  textCacheChars -= oldest.length + value.length;
}

/** テストからキャッシュの大きさだけを見る。中身は返さない */
export function markdownTextCacheSize(): { entries: number; chars: number } {
  return { entries: textCache.size, chars: textCacheChars };
}

/** エスケープしていた & を文字に戻す。文字参照は、戻すトークン側で処理してある */
function restorePlain(s: string): string {
  return s.replaceAll(ESCAPED_AMP, "&");
}

/** 検索・メンション・抜粋用の文字だけ。同じ文字列は、2000 件かつ長さの合計 400 万文字まで覚えておく */
export function markdownToText(md: string): string {
  const cached = textCache.get(md);
  if (cached !== undefined) return cached;
  const text = restorePlain(blocksText(createMarked().lexer(md))).replace(/\s+/g, " ").trim();
  const weight = md.length + text.length;
  if (weight > TEXT_CACHE_MAX_ENTRY) return text;
  textCache.set(md, text);
  textCacheChars += weight;
  while (textCache.size > TEXT_CACHE_LIMIT || textCacheChars > TEXT_CACHE_MAX_CHARS) {
    const before = textCache.size;
    dropOldestText();
    if (textCache.size === before) break;
  }
  return text;
}

function plainLines(tokens: Token[]): string[] {
  return tokens.flatMap((token) => plainBlockLines(token));
}

function plainBlockLines(token: Token): string[] {
  switch (token.type) {
    case "space":
    case "hr":
    case "def":
    case "checkbox":
    case "footnoteReference":
      return [];
    case "code":
    case "codespan":
      return softenNbsp(token.text).replace(/\n$/, "").split("\n");
    case "heading":
    case "paragraph":
    case "strong":
    case "em":
    case "del":
    case "link":
      return plainInline(token.tokens).split("\n");
    case "blockquote":
    case "alert":
    case "footnoteDefinition":
      return plainLines((token as Tokens.Generic).tokens ?? []);
    case "list": {
      const list = token as Tokens.List;
      return list.items.flatMap((item) => plainLines(item.tokens));
    }
    case "table":
      return tableLines(token as Tokens.Table);
    case "html":
      return htmlPlain(token.text).split("\n");
    case "text":
      return (token.tokens?.length ? plainInline(token.tokens) : decodePlainText(token.text)).split("\n");
    default:
      if (token.type === "inlineHtml") return htmlPlain(String(token.raw ?? "")).split("\n");
      return (token as Tokens.Generic).tokens ? plainLines((token as Tokens.Generic).tokens ?? []) : [];
  }
}

function tableLines(table: Tokens.Table): string[] {
  return [table.header, ...table.rows].flatMap((row) => {
    const cells = row.map((cell) => plainInline(cell.tokens).split("\n"));
    const height = Math.max(1, ...cells.map((lines) => lines.length));
    const lines: string[] = [];
    for (let i = 0; i < height; i++) lines.push(cells.map((cell) => cell[i] ?? "").join(" | "));
    return lines;
  });
}

/**
 * スプレッドシートの説明列用。段落・見出し・コードブロックの各行・引用・注記・脚注の定義、
 * リスト項目、表の行、改行（br）を改行で区切る。1 行の中の空白はまとめ、空行は詰める。
 * リンクの URL は含めず、HTML のタグは除く。結果は覚えない。
 */
export function markdownToPlainLines(md: string): string {
  return plainLines(createMarked().lexer(md))
    .map((line) => restorePlain(line).replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** 空白だけ、または文字が無く、表示される画像も水平線も無いとき */
export function isMarkdownBlank(md: string): boolean {
  if (md.trim() === "") return true;
  if (markdownToText(md) !== "") return false;
  return !hasImageOrRule(createMarked().lexer(md));
}

/** 表示用の HTML。このモジュール単体でも、生の HTML や危険な URL はタグにならない */
export function markdownToHtml(md: string): string {
  if (!md.trim()) return "";
  return createMarked().parse(md, { async: false }).replace(/\n+$/, "");
}
