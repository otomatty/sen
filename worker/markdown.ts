// 既存データを HTML から Markdown に移すときだけ使う。
// 新しい本文は、受け取った Markdown をそのまま保存する。表示用の HTML は shared/markdown.ts が作る。
// Workers とブラウザの両方で動くよう、DOM も Node の API も使わない。

import { HTML4_NAMED_ENTITIES } from "../shared/html4-entities";


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

/**
 * 数値と、HTML 4 の表にある名前を 1 回だけ戻す。表に無い名前はそのまま残す。
 * 名前の大文字小文字は区別する。amp・lt・gt・quot・apos・nbsp だけは、これまで通り区別しない。
 * apos は HTML 4 の表に無い。これまで戻していたので、そのまま戻す。
 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g, (all, ent: string) => {
    if (ent[0] === "#") {
      const hex = ent[1] === "x" || ent[1] === "X";
      const cp = hex ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
      return String.fromCodePoint(cp);
    }
    const named = HTML4_NAMED_ENTITIES[ent];
    if (named !== undefined) return named;
    switch (ent.toLowerCase()) {
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
      default:
        return all;
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
      // GFM は ~ が 1 つでも取り消し線になる。
      .replace(/~/g, "\\~")
  );
}

interface Piece {
  text: string;
  /** 元の HTML のテキストノード。行頭のエスケープはここだけにかける。 */
  fromText: boolean;
}

function piecesToString(pieces: Piece[]): string {
  let out = "";
  for (const piece of pieces) out += piece.text;
  return out;
}

function pieceMask(pieces: Piece[]): boolean[] {
  const mask: boolean[] = [];
  for (const piece of pieces) {
    for (let i = 0; i < piece.text.length; i++) mask.push(piece.fromText);
  }
  return mask;
}

/** String.prototype.trim と同じ範囲。全部空白なら [0, 0] */
function trimOffsets(text: string): [number, number] {
  const trimmed = text.trim();
  if (!trimmed) return [0, 0];
  const start = text.indexOf(trimmed);
  return [start, start + trimmed.length];
}

function slicePieces(pieces: Piece[], start: number, end: number): Piece[] {
  const out: Piece[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const pieceEnd = offset + piece.text.length;
    if (pieceEnd > start && offset < end) {
      const text = piece.text.slice(Math.max(0, start - offset), Math.min(piece.text.length, end - offset));
      if (text) out.push({ text, fromText: piece.fromText });
    }
    offset = pieceEnd;
  }
  return out;
}

function trimPieces(pieces: Piece[]): Piece[] {
  const raw = piecesToString(pieces);
  const [start, end] = trimOffsets(raw);
  if (start === 0 && end === raw.length) return pieces;
  return slicePieces(pieces, start, end);
}

/**
 * 段落の各行を、見出し・リスト・引用・フェンス・水平線・下線見出しとして読まれないようにする。
 * 行頭の空白は HTML では見えないので取り除く（4 個以上残るとコードブロックになる）。
 * エスケープはテキストノード由来の文字だけ。行内コードの区切りや太字・斜体・リンクの記号にはかけない。
 */
function protectPieces(pieces: Piece[]): string {
  const raw = piecesToString(pieces);
  const mask = pieceMask(pieces);
  const [start, end] = trimOffsets(raw);
  if (start === end) return "";
  const text = raw.slice(start, end);
  const fromText = mask.slice(start, end);
  const lines: string[] = [];
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== "\n") continue;
    let skip = 0;
    while (lineStart + skip < i && (text[lineStart + skip] === " " || text[lineStart + skip] === "\t")) skip++;
    const from = lineStart + skip;
    lines.push(escapeLineStart(text.slice(from, i), fromText.slice(from, i)));
    lineStart = i + 1;
  }
  return lines.join("\n");
}

function escapeLineStart(line: string, fromText: boolean[]): string {
  // `1.` の数字の前に \ を置いてもエスケープにならない。点か括弧の前に置く。
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
  if (ordered) {
    if (fromText[ordered[1].length]) return `${ordered[1]}\\${ordered[2]}${line.slice(ordered[0].length)}`;
    return line;
  }
  const atStart =
    /^#{1,6}(?:[ \t]|$)/.test(line) ||
    line.startsWith(">") ||
    /^[-+*](?:[ \t]|$)/.test(line) ||
    /^(?:`{3,}|~{3,})/.test(line) ||
    /^(?:=+|-+)[ \t]*$/.test(line) ||
    /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
  if (atStart && fromText[0]) return `\\${line}`;
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

/** 区切りは変換が作った記法。中の文字はテキストノードなので、行が分かれたときだけ行頭をエスケープする。 */
function codeSpanPieces(el: El): Piece[] {
  const text = rawText(el);
  const fence = fenceFor(text, "`", 1);
  const pad = /^`|`$|^\s|\s$/.test(text) ? " " : "";
  const pieces: Piece[] = [{ text: fence + pad, fromText: false }];
  if (text) pieces.push({ text, fromText: true });
  pieces.push({ text: pad + fence, fromText: false });
  return pieces;
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

/** CommonMark では、1 以外から始まる番号付きリストは段落の途中では始まらない */
function orderedListNeedsBlankLine(text: string): boolean {
  const nl = text.indexOf("\n");
  const line = nl === -1 ? text : text.slice(0, nl);
  const marker = /^(\d{1,9})\./.exec(line);
  return marker !== null && Number(marker[1]) !== 1;
}

function joinBlocks(parts: Block[]): string {
  let out = "";
  for (const p of parts) {
    if (!p.text) continue;
    if (!out) {
      out = p.text;
      continue;
    }
    const separate = p.kind !== "list" || orderedListNeedsBlankLine(p.text);
    out += (separate ? "\n\n" : "\n") + p.text;
  }
  return out;
}

/** edgeBefore / edgeAfter は、この並びの外側の隣。その側に文字が無い子には、それを隣として渡す */
function renderPieces(nodes: Node[], edgeBefore: string | null = null, edgeAfter: string | null = null): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === "text") {
      if (n.text) out.push({ text: escapeInline(n.text), fromText: true });
      continue;
    }
    const before = lastOutputChar(out) ?? edgeBefore;
    const after = firstNeighborChar(nodes, i + 1) ?? edgeAfter;
    const inline = inlinePieces(n, before, after);
    if (inline) {
      out.push(...inline);
      continue;
    }
    const text = renderElement(n);
    if (text) out.push({ text, fromText: false });
  }
  return out;
}

function renderInline(nodes: Node[]): string {
  return piecesToString(renderPieces(nodes));
}

/** 句読点は Unicode の P と S。空白は区切りの外に出す対象（行頭・行末は呼び出し側が null で表す） */
function isPunct(ch: string): boolean {
  return /[\p{P}\p{S}]/u.test(ch);
}

function isWhitespace(ch: string): boolean {
  return /[\p{Zs}\t\n\f\r]/u.test(ch);
}

/** 空白でも句読点でもない文字。行頭・行末や、テキストでない隣は null */
function isWordish(ch: string | null): boolean {
  return ch != null && !isWhitespace(ch) && !isPunct(ch);
}

function lastCodePoint(s: string): string | null {
  if (!s) return null;
  const end = s.length - 1;
  const tail = s.charCodeAt(end);
  if (tail >= 0xdc00 && tail <= 0xdfff && end > 0) {
    const lead = s.charCodeAt(end - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) return s.slice(end - 1);
  }
  return s[end] ?? null;
}

function firstCodePoint(s: string): string | null {
  if (!s) return null;
  const cp = s.codePointAt(0);
  return cp === undefined ? null : String.fromCodePoint(cp);
}

function lastOutputChar(pieces: Piece[]): string | null {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const ch = lastCodePoint(pieces[i].text);
    if (ch) return ch;
  }
  return null;
}

interface FlatChar {
  ch: string;
  fromText: boolean;
}

function flattenPieces(pieces: Piece[]): FlatChar[] {
  const out: FlatChar[] = [];
  for (const piece of pieces) {
    for (const ch of piece.text) out.push({ ch, fromText: piece.fromText });
  }
  return out;
}

function charsToPieces(chars: FlatChar[]): Piece[] {
  const out: Piece[] = [];
  for (const c of chars) {
    const last = out[out.length - 1];
    if (last && last.fromText === c.fromText) last.text += c.ch;
    else out.push({ text: c.ch, fromText: c.fromText });
  }
  return out;
}

/**
 * 強調の直後に出る文字。空白ならその空白、そうでなければ句読点（区切りや動かした句読点）か本文の文字。
 * 強調そのものは、先頭の空白以外、最初の文字が文字や数字になることはない。
 */
function openingCharOf(node: Node): string | null {
  if (node.type === "text") {
    if (!node.text) return null;
    return firstCodePoint(escapeInline(node.text));
  }
  switch (node.tag) {
    case "br":
      return "\n";
    case "input":
      return null;
    case "img":
      return firstCodePoint(escapeInline((node.attrs.alt ?? "").trim() || node.attrs.src || ""));
    case "code":
      return "`";
    case "a":
      return (node.attrs.href ?? "").trim() ? "[" : openingCharOfNodes(node.children);
    case "strong":
    case "b":
    case "em":
    case "i":
    case "s":
    case "del":
    case "strike":
      return openingCharOfEmphasis(node);
    default:
      if (BLOCK_TAGS.has(node.tag)) return null;
      return openingCharOfNodes(node.children);
  }
}

function openingCharOfNodes(nodes: Node[]): string | null {
  for (const n of nodes) {
    const ch = openingCharOf(n);
    if (ch) return ch;
  }
  return null;
}

function openingCharOfEmphasis(el: El): string | null {
  const chars = flattenPieces(renderPieces(el.children));
  if (chars.length && chars[0].fromText && isWhitespace(chars[0].ch)) return chars[0].ch;
  if (!chars.length) return null;
  return "*";
}

function firstNeighborChar(nodes: Node[], index: number): string | null {
  for (let i = index; i < nodes.length; i++) {
    const ch = openingCharOf(nodes[i]);
    if (ch) return ch;
  }
  return null;
}

function isBlankText(n: Node): boolean {
  return n.type === "text" && n.text.trim() === "";
}

/** 空白だけのテキストを除いて、リンクがちょうど 1 つのときだけリンクを返す */
function singleLink(children: Node[]): { link: El; leading: Node[]; trailing: Node[] } | null {
  const leading: Node[] = [];
  const trailing: Node[] = [];
  let link: El | null = null;
  for (const child of children) {
    if (!link) {
      if (isBlankText(child)) {
        leading.push(child);
        continue;
      }
      if (child.type === "el" && child.tag === "a" && (child.attrs.href ?? "").trim()) {
        link = child;
        continue;
      }
      return null;
    }
    if (isBlankText(child)) {
      trailing.push(child);
      continue;
    }
    return null;
  }
  if (!link) return null;
  return { link, leading, trailing };
}

function markedLink(el: El, marker: string): Piece[] {
  const href = (el.attrs.href ?? "").trim();
  const inner = trimPieces(renderPieces(el.children));
  if (!piecesToString(inner)) return [{ text: `[](${linkDestination(href)})`, fromText: false }];
  return [
    { text: "[", fromText: false },
    { text: marker, fromText: false },
    ...inner,
    { text: marker, fromText: false },
    { text: `](${linkDestination(href)})`, fromText: false },
  ];
}

/**
 * 端の空白は常に区切りの外へ出す。空白だけなら区切りを付けない。
 * 端の句読点は、どちらかの外側が文字（空白でも句読点でもない）のとき、両端とも外へ出す。
 * 外に出せるのは元の HTML の文字だけ。中身が残らなければ区切りを付けない。
 * 両側が行頭・行末・空白・句読点なら、句読点は中に残す（`**#** と` のように区切りが効くため）。
 */
function emphasize(marker: string, pieces: Piece[], before: string | null, after: string | null): Piece[] {
  const chars = flattenPieces(pieces);
  if (!chars.length) return [];
  let start = 0;
  while (start < chars.length && chars[start].fromText && isWhitespace(chars[start].ch)) start++;
  let end = chars.length;
  while (end > start && chars[end - 1].fromText && isWhitespace(chars[end - 1].ch)) end--;
  const leadWs = chars.slice(0, start);
  const trailWs = chars.slice(end);
  if (start === end) return charsToPieces(chars);

  const neighborBefore = leadWs.length ? leadWs[leadWs.length - 1].ch : before;
  const neighborAfter = trailWs.length ? trailWs[0].ch : after;
  let coreStart = start;
  let coreEnd = end;
  if (isWordish(neighborBefore) || isWordish(neighborAfter)) {
    while (coreStart < coreEnd && chars[coreStart].fromText && isPunct(chars[coreStart].ch)) coreStart++;
    while (coreEnd > coreStart && chars[coreEnd - 1].fromText && isPunct(chars[coreEnd - 1].ch)) coreEnd--;
  }
  if (coreStart === coreEnd) return charsToPieces(chars);
  return [
    ...charsToPieces(leadWs),
    ...charsToPieces(chars.slice(start, coreStart)),
    { text: marker, fromText: false },
    ...charsToPieces(chars.slice(coreStart, coreEnd)),
    { text: marker, fromText: false },
    ...charsToPieces(chars.slice(coreEnd, end)),
    ...charsToPieces(trailWs),
  ];
}

function wrapMarked(marker: string, el: El, before: string | null, after: string | null): Piece[] {
  const around = singleLink(el.children);
  if (around) return [...renderPieces(around.leading), ...markedLink(around.link, marker), ...renderPieces(around.trailing)];
  // 端の子の強調は、間に文字が無ければ親の外側をその側の隣にする。
  // 区切りが隣り合うと 1 つになり、効くかどうかは外側の文字で決まる。内側が句読点を外に出せば、親も元の文字として外に出せる。
  return emphasize(marker, renderPieces(el.children, before, after), before, after);
}

function linkPieces(el: El): Piece[] {
  const href = (el.attrs.href ?? "").trim();
  const inner = trimPieces(renderPieces(el.children));
  const text = piecesToString(inner);
  const plain = rawText(el).replace(/\s+/g, " ").trim();
  if (!href) return inner;
  // <href> は自動リンクになる http / https / mailto だけ。/docs や #goal は [文字](href) に戻す
  if ((plain === href || text === href) && /^(https?:|mailto:)/i.test(href)) return [{ text: `<${href}>`, fromText: false }];
  return [{ text: "[", fromText: false }, ...inner, { text: `](${linkDestination(href)})`, fromText: false }];
}

/** インライン要素を、テキストと変換が作った記法に分けて返す。ブロックなら null */
function inlinePieces(el: El, before: string | null, after: string | null): Piece[] | null {
  switch (el.tag) {
    case "br":
      return [{ text: "\n", fromText: false }];
    case "strong":
    case "b":
      return wrapMarked("**", el, before, after);
    case "em":
    case "i":
      return wrapMarked("*", el, before, after);
    case "s":
    case "del":
    case "strike":
      return wrapMarked("~~", el, before, after);
    case "u":
    case "span":
    case "label":
      return renderPieces(el.children);
    case "code":
      return codeSpanPieces(el);
    case "a":
      return linkPieces(el);
    case "img":
      return [{ text: escapeInline((el.attrs.alt ?? "").trim() || el.attrs.src || ""), fromText: true }];
    case "input":
      return [];
    default:
      if (BLOCK_TAGS.has(el.tag) || hasBlock(el.children)) return null;
      return renderPieces(el.children);
  }
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
    const text = protectPieces(renderPieces(inline));
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

/** 末尾の「空白 + #」は ATX 見出しの閉じ記号になるので、その # をエスケープする */
function escapeTrailingHeadingHashes(text: string): string {
  return text.replace(/(\s)(#+$)/, (_all, space: string, hashes: string) => `${space}${"\\#".repeat(hashes.length)}`);
}

function renderElement(el: El): string {
  const inline = inlinePieces(el, null, null);
  if (inline) return piecesToString(inline);
  switch (el.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = escapeTrailingHeadingHashes(renderInline(el.children).trim());
      return `${"#".repeat(Number(el.tag[1]))} ${text}`.trimEnd();
    }
    case "p":
      return protectPieces(renderPieces(el.children));
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
    case "hr":
      return "---";
    case "div":
      return renderBlocks(el.children);
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
