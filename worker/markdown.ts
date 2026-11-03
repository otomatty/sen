// AI ツールは Markdown で書き、Sen は Tiptap（StarterKit + チェックリスト + リンク、見出しは h1〜h3）の HTML で保存する。
// その間を変換する。Workers とブラウザの両方で動くよう、DOM も Node の API も使わない。

import { Marked, type Tokens } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** リンクにしてよい href だけを通す（javascript: などはテキストにする）。画面の sanitize と同じく / と # も許可する */
function isSafeHref(href: string): boolean {
  if (!href || /[\u0000-\u0020]/.test(href)) return false;
  return /^(https?:|mailto:|\/|#)/i.test(href);
}

/** タスク項目の中身を、Tiptap と同じくブロック（最低でも p）にする */
function taskBody(html: string): string {
  const t = html.replace(/\n+$/, "").trim();
  if (!t) return "<p></p>";
  const block = /<(?:ul|ol|p|pre|blockquote|h[1-6]|hr|div)\b/i.exec(t);
  if (!block) return `<p>${t}</p>`;
  if (block.index === 0) return t;
  const before = t.slice(0, block.index).trim();
  const after = t.slice(block.index);
  return before ? `<p>${before}</p>${after}` : after;
}

function taskCheckbox(checked: boolean): string {
  return checked ? `<input type="checkbox" checked disabled>` : `<input type="checkbox" disabled>`;
}

function renderTaskItem(parser: { parse(tokens: Tokens.ListItem["tokens"]): string }, item: Tokens.ListItem): string {
  const checked = !!item.checked;
  const inner = taskBody(parser.parse(item.tokens));
  return `<li data-type="taskItem" data-checked="${checked}"><label>${taskCheckbox(checked)}</label><div>${inner}</div></li>`;
}

const marked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      const escaped = escapeHtml(token.text);
      return token.block ? `${escaped}\n` : escaped;
    },
    heading({ tokens, depth }) {
      const level = Math.min(depth, 3);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`;
    },
    link(token) {
      const text = token.autolink ? escapeHtml(token.text) : this.parser.parseInline(token.tokens);
      if (!isSafeHref(token.href)) return text;
      return `<a href="${escapeHtml(token.href)}">${text}</a>`;
    },
    image(token) {
      const label = token.text.trim() ? token.text.trim() : token.href;
      if (!isSafeHref(token.href)) return escapeHtml(label);
      return `<a href="${escapeHtml(token.href)}">${escapeHtml(label)}</a>`;
    },
    table(token) {
      return `<pre><code>${escapeHtml(token.raw.replace(/\n$/, ""))}</code></pre>\n`;
    },
    checkbox() {
      return "";
    },
    list(token) {
      // 通常の項目とタスク項目が混ざっていたら、連続するまとまりごとに別のリストへ分ける。
      // タスクはチェックリスト、通常は元の ul / ol。番号付きを分けたあとは start で番号を続ける。
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
  },
});

/** Markdown を、Sen が保存する Tiptap の HTML にする */
export function markdownToHtml(md: string): string {
  if (!md || !md.trim()) return "";
  return marked.parse(md, { async: false }).replace(/\n+$/, "");
}

// ---- HTML → Markdown（DOM を使わない小さなパーサー） ----

interface El {
  type: "el";
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
interface TextNode {
  type: "text";
  text: string;
}
type Node = El | TextNode;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
]);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, ent: string) => {
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
        return "\u00A0";
      default: {
        const hex = e.startsWith("#x");
        const cp = hex ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
        return String.fromCodePoint(cp);
      }
    }
  });
}

function escapeInline(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/([*`[\]])/g, "\\$1")
    // user_id のような語中の _ は読めるように残す。前後が英数字のときだけ。
    .replace(/_/g, (match: string, offset: number, str: string) => {
      const prev = str[offset - 1] ?? "";
      const next = str[offset + 1] ?? "";
      if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) return match;
      return "\\_";
    })
    .replace(/~~/g, "\\~\\~");
}

/** 段落の行頭が見出しやリストとして読まれないようにする */
function protectLines(s: string): string {
  return s
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(#{1,6}\s|>|[-+]\s|\d{1,9}[.)]\s)/.test(line) || /^\s{0,3}([-*_])\1{2,}\s*$/.test(line)) {
        return line.replace(/^(\s{0,3})(\S)/, "$1\\$2");
      }
      return line;
    })
    .join("\n");
}

interface TagInfo {
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

function readTag(s: string, i: number): TagInfo | null {
  if (s[i] !== "<") return null;
  let j = i + 1;
  let closing = false;
  if (s[j] === "/") {
    closing = true;
    j++;
  }
  if (!/[A-Za-z]/.test(s[j] ?? "")) return null;
  const nameStart = j;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  const name = s.slice(nameStart, j).toLowerCase();
  const attrs: Record<string, string> = {};
  let selfClosing = false;
  while (j < s.length) {
    while (j < s.length && /\s/.test(s[j])) j++;
    if (j >= s.length) return null;
    if (s[j] === ">") {
      j++;
      break;
    }
    if (s[j] === "/" && s[j + 1] === ">") {
      selfClosing = true;
      j += 2;
      break;
    }
    if (closing || !/[A-Za-z_:]/.test(s[j] ?? "")) return null;
    const aStart = j;
    while (j < s.length && /[^\s=/>]/.test(s[j])) j++;
    const attr = s.slice(aStart, j).toLowerCase();
    while (j < s.length && /\s/.test(s[j])) j++;
    let value = "";
    if (s[j] === "=") {
      j++;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length) return null;
      const q = s[j];
      if (q === '"' || q === "'") {
        j++;
        const end = s.indexOf(q, j);
        if (end < 0) return null;
        value = s.slice(j, end);
        j = end + 1;
      } else {
        const vStart = j;
        while (j < s.length && !/[\s>]/.test(s[j])) j++;
        value = s.slice(vStart, j);
        if (value.endsWith("/") && s[j] === ">") {
          value = value.slice(0, -1);
          selfClosing = true;
        }
      }
    }
    attrs[attr] = decodeEntities(value);
  }
  return { name, attrs, closing, selfClosing, end: j };
}

function appendText(parent: El, text: string) {
  if (!text) return;
  const last = parent.children[parent.children.length - 1];
  if (last && last.type === "text") last.text += text;
  else parent.children.push({ type: "text", text });
}

function parseHtml(input: string): El {
  const root: El = { type: "el", tag: "root", attrs: {}, children: [] };
  const stack: El[] = [root];
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "<") {
      const next = input.indexOf("<", i);
      const end = next === -1 ? input.length : next;
      appendText(stack[stack.length - 1], decodeEntities(input.slice(i, end)));
      i = end;
      continue;
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
      const end = input.indexOf(">", i + 2);
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    const tag = readTag(input, i);
    if (!tag) {
      appendText(stack[stack.length - 1], "<");
      i++;
      continue;
    }
    i = tag.end;
    if (tag.closing) {
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === tag.name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const el: El = { type: "el", tag: tag.name, attrs: tag.attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) stack.push(el);
  }
  return root;
}

function rawText(n: Node): string {
  if (n.type === "text") return n.text;
  return n.children.map(rawText).join("");
}

function codeLang(el: El): string {
  const code = el.children.find((c): c is El => c.type === "el" && c.tag === "code");
  const cls = (code?.attrs.class ?? el.attrs.class ?? "").trim();
  const m = /(?:^|\s)language-([A-Za-z0-9_+#.-]+)/.exec(cls);
  return m?.[1] ?? "";
}

function fenceFor(text: string, ch: string, min: number): string {
  let n = min;
  const re = new RegExp(`${ch}+`, "g");
  for (const run of text.match(re) ?? []) n = Math.max(n, run.length + 1);
  return ch.repeat(n);
}

function renderCodeSpan(el: El): string {
  const text = rawText(el);
  const fence = fenceFor(text, "`", 1);
  const pad = /^`|`$|^\s|\s$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function renderPre(el: El): string {
  const code = el.children.find((c): c is El => c.type === "el" && c.tag === "code");
  const text = (code ? rawText(code) : rawText(el)).replace(/\n$/, "");
  const fence = fenceFor(text, "`", 3);
  return `${fence}${codeLang(el)}\n${text}\n${fence}`;
}

interface Block {
  text: string;
  kind: "list" | "other";
}

function joinBlocks(parts: Block[]): string {
  let out = "";
  for (const p of parts) {
    if (!p.text) continue;
    if (!out) {
      out = p.text;
      continue;
    }
    out += (p.kind === "list" ? "\n" : "\n\n") + p.text;
  }
  return out;
}

function renderInline(nodes: Node[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += escapeInline(n.text);
    else out += renderElement(n);
  }
  return out;
}

function hasBlock(nodes: Node[]): boolean {
  return nodes.some((n) => n.type === "el" && (BLOCK_TAGS.has(n.tag) || hasBlock(n.children)));
}

function collect(nodes: Node[]): Block[] {
  const parts: Block[] = [];
  for (const n of nodes) {
    if (n.type === "text") {
      if (!n.text.trim()) continue;
      parts.push({ text: protectLines(escapeInline(n.text.trim())), kind: "other" });
      continue;
    }
    const text = renderElement(n).replace(/\n+$/, "");
    if (!text.trim() && n.tag !== "hr") continue;
    parts.push({ text, kind: n.tag === "ul" || n.tag === "ol" ? "list" : "other" });
  }
  return parts;
}

function renderBlocks(nodes: Node[]): string {
  return joinBlocks(collect(nodes));
}

function parseStart(v: string | undefined): number {
  if (!v) return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return 1;
  return n;
}

function hasCheckedInput(n: Node): boolean {
  if (n.type !== "el") return false;
  if (n.tag === "input" && Object.prototype.hasOwnProperty.call(n.attrs, "checked") && n.attrs.checked !== "false") return true;
  return n.children.some(hasCheckedInput);
}

function taskChecked(li: El): boolean {
  const v = li.attrs["data-checked"];
  if (v === "true") return true;
  if (v === "false") return false;
  return hasCheckedInput(li);
}

function listItemNodes(li: El): Node[] {
  const nodes = li.children.filter((n) => {
    if (n.type === "text" && !n.text.trim()) return false;
    if (n.type === "el" && n.tag === "input") return false;
    return true;
  });
  if (nodes.length === 1 && nodes[0].type === "el" && nodes[0].tag === "div") return nodes[0].children;
  return nodes;
}

/** 続きの行・入れ子の字下げ。マーカーの幅 + 1（チェックボックスは本文なので - と同じ 2） */
function continuationPad(marker: string): string {
  const width = marker === "- [ ]" || marker === "- [x]" ? 2 : marker.length + 1;
  return " ".repeat(width);
}

function applyMarker(body: string, marker: string): string {
  if (!body) return marker;
  const pad = continuationPad(marker);
  return body
    .split("\n")
    .map((line, i) => {
      if (i === 0) return `${marker} ${line}`;
      if (!line) return "";
      return pad + line;
    })
    .join("\n");
}

function renderList(el: El): string {
  const parentTask = el.attrs["data-type"] === "taskList";
  const ordered = el.tag === "ol";
  let n = ordered ? parseStart(el.attrs.start) : 1;
  const lines: string[] = [];
  for (const child of el.children) {
    if (child.type !== "el" || child.tag !== "li") continue;
    const task = parentTask || child.attrs["data-type"] === "taskItem";
    let marker: string;
    if (task) marker = taskChecked(child) ? "- [x]" : "- [ ]";
    else if (ordered) marker = `${n++}.`;
    else marker = "-";
    lines.push(applyMarker(renderBlocks(listItemNodes(child)).trim(), marker));
  }
  return lines.join("\n");
}

function renderElement(el: El): string {
  switch (el.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = renderInline(el.children).trim();
      return `${"#".repeat(Number(el.tag[1]))} ${text}`.trimEnd();
    }
    case "p":
      return protectLines(renderInline(el.children).trim());
    case "br":
      return "\n";
    case "strong":
    case "b": {
      const inner = renderInline(el.children);
      return inner ? `**${inner}**` : "";
    }
    case "em":
    case "i": {
      const inner = renderInline(el.children);
      return inner ? `*${inner}*` : "";
    }
    case "s":
    case "del":
    case "strike": {
      const inner = renderInline(el.children);
      return inner ? `~~${inner}~~` : "";
    }
    case "u":
    case "span":
    case "label":
      return renderInline(el.children);
    case "code":
      return renderCodeSpan(el);
    case "pre":
      return renderPre(el);
    case "blockquote": {
      const inner = renderBlocks(el.children).trim();
      if (!inner) return "";
      return inner
        .split("\n")
        .map((l) => (l.length ? `> ${l}` : ">"))
        .join("\n");
    }
    case "ul":
    case "ol":
      return renderList(el);
    case "li":
      return renderBlocks(listItemNodes(el));
    case "a": {
      const href = (el.attrs.href ?? "").trim();
      const text = renderInline(el.children).trim();
      const plain = rawText(el).replace(/\s+/g, " ").trim();
      if (!href) return text;
      // <href> は自動リンクになる http / https / mailto だけ。/docs や #goal は [文字](href) に戻す
      if ((plain === href || text === href) && /^(https?:|mailto:)/i.test(href)) return `<${href}>`;
      return `[${text}](${href})`;
    }
    case "hr":
      return "---";
    case "div":
      return renderBlocks(el.children);
    case "input":
      return "";
    case "img":
      return escapeInline((el.attrs.alt ?? "").trim() || el.attrs.src || "");
    default:
      return hasBlock(el.children) ? renderBlocks(el.children) : renderInline(el.children);
  }
}

/** 連続する空行を 1 つにまとめる。コードフェンスの中は変えない */
function collapseBlankLines(md: string): string {
  const lines = md.split("\n");
  let fence: string | null = null;
  let blanks = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = /^\s*(```+|~~~+)\s*$/.exec(line);
      if (close && close[1] === fence) fence = null;
      continue;
    }
    const open = /^\s*(```+|~~~+)/.exec(line);
    if (open) {
      fence = open[1];
      blanks = 0;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      blanks++;
      if (blanks === 1) out.push("");
      continue;
    }
    blanks = 0;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Sen が保存した HTML を Markdown に戻す */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  const root = parseHtml(html.replace(/\r\n?/g, "\n"));
  return collapseBlankLines(renderBlocks(root.children));
}
