// 既存データを HTML から Markdown に移すときだけ使う。
// 新しい本文は、受け取った Markdown をそのまま保存する。表示用の HTML は shared/markdown.ts が作る。
// Workers とブラウザの両方で動くよう、DOM も Node の API も使わない。


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
  return (
    s
      // HTML のテキスト中の改行は空白と同じ。残すと、表示側の改行で行が増える。
      .replace(/\n/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/([*`[\]])/g, "\\$1")
      .replace(/\|/g, "\\|")
      // 生の HTML や自動リンクとして読まれないようにする。
      .replace(/<(?=[A-Za-z/!?])/g, "\\<")
      // `&amp;amp;` のように見えていた文字が、`&` に化けないようにする。
      .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
      // user_id のような語中の _ は読めるように残す。前後が英数字のときだけ。
      .replace(/_/g, (match: string, offset: number, str: string) => {
        const prev = str[offset - 1] ?? "";
        const next = str[offset + 1] ?? "";
        if (/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next)) return match;
        return "\\_";
      })
      .replace(/~~/g, "\\~\\~")
  );
}

/**
 * 段落の各行を、見出し・リスト・引用・フェンス・水平線・下線見出しとして読まれないようにする。
 * 行頭の空白は HTML では見えないので取り除く（4 個以上残るとコードブロックになる）。
 */
function protectLines(s: string): string {
  return s
    .split("\n")
    .map((line) => escapeLineStart(line.replace(/^[ \t]+/, "")))
    .join("\n");
}

function escapeLineStart(line: string): string {
  // `1.` の数字の前に \ を置いてもエスケープにならない。点か括弧の前に置く。
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
  if (ordered) return `${ordered[1]}\\${ordered[2]}${line.slice(ordered[0].length)}`;
  if (/^#{1,6}(?:[ \t]|$)/.test(line)) return `\\${line}`;
  if (line.startsWith(">")) return `\\${line}`;
  if (/^[-+*](?:[ \t]|$)/.test(line)) return `\\${line}`;
  if (/^(?:`{3,}|~{3,})/.test(line)) return `\\${line}`;
  if (/^(?:=+|-+)[ \t]*$/.test(line)) return `\\${line}`;
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return `\\${line}`;
  return line;
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

/**
 * 隣り合うテキストとインライン要素は 1 つの段落にする。
 * marked は詰まったリスト項目を p で包まないので、分けて描くと往復で割れる。
 * 空白だけのテキストは、まとまりの前後では捨て、語の間では残す。
 */
function collect(nodes: Node[]): Block[] {
  const parts: Block[] = [];
  let inline: Node[] = [];

  const flushInline = () => {
    if (!inline.length) return;
    const text = protectLines(renderInline(inline).trim());
    inline = [];
    if (!text) return;
    parts.push({ text, kind: "other" });
  };

  for (const n of nodes) {
    if (n.type === "text" || !BLOCK_TAGS.has(n.tag)) {
      inline.push(n);
      continue;
    }
    flushInline();
    const text = renderElement(n).replace(/\n+$/, "");
    if (!text.trim() && n.tag !== "hr") continue;
    parts.push({ text, kind: n.tag === "ul" || n.tag === "ol" ? "list" : "other" });
  }
  flushInline();
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
  const nodes = li.children.filter((n) => !(n.type === "el" && n.tag === "input"));
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

/** `( )` 空白 `<` `>` を含むリンク先は `<href>` で囲む。中の `<` `>` は先にパーセントにする */
function linkDestination(href: string): string {
  if (!/[()\s<>]/.test(href)) return href;
  return `<${href.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
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
      return `[${text}](${linkDestination(href)})`;
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

/** 保存済みの HTML を Markdown にする。データの移行以外では使わない */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  const root = parseHtml(html.replace(/\r\n?/g, "\n"));
  return collapseBlankLines(renderBlocks(root.children));
}
