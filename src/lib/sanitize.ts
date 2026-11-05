// 表示専用の HTML サニタイザ（許可リスト方式）。
// エディタ（Tiptap）と markdownToHtml が出力する要素だけを残し、それ以外は中身のテキストだけにする。

import { ALERT_LABELS, ALERT_TYPES, type AlertType } from "../../shared/markdown";

const ALLOWED: Record<string, string[]> = {
  p: [],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  s: [],
  u: [],
  code: ["class"],
  pre: ["class"],
  ul: ["data-type"],
  ol: ["start"],
  li: ["data-type", "data-checked"],
  blockquote: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  a: ["href"],
  label: [],
  span: [],
  div: ["class", "data-alert", "data-alert-label", "data-label"],
  sup: ["class", "data-label"],
  input: ["type", "checked", "disabled"],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["data-align"],
  td: ["data-align"],
  img: ["src", "alt", "title"],
};

const ALERT_LABEL_SET = new Set<string>(Object.values(ALERT_LABELS));

function allowedClass(tag: string, value: string): string | null {
  const parts = value.split(/\s+/).filter(Boolean);
  if (tag === "div") {
    const hit = parts.find((part) => part === "md-alert" || part === "md-footnote");
    return hit ?? null;
  }
  if (tag === "sup") return parts.includes("md-footnote-ref") ? "md-footnote-ref" : null;
  if (tag === "pre") return parts.includes("md-raw-html") ? "md-raw-html" : null;
  if (tag === "code") {
    const kept = parts.filter((part) => part === "md-raw-html" || /^language-[A-Za-z0-9_+#-]+$/.test(part));
    return kept.length ? kept.join(" ") : null;
  }
  return null;
}

function safeLabel(value: string): boolean {
  return value.length <= 40 && !/[\s"<>]/.test(value);
}

function sanitizeImage(el: Element, doc: Document): Node {
  const src = (el.getAttribute("src") ?? "").trim();
  const alt = el.getAttribute("alt") ?? "";
  if (!/^https?:/i.test(src)) return doc.createTextNode(alt);
  const img = doc.createElement("img");
  img.setAttribute("src", src);
  img.setAttribute("alt", alt);
  const title = el.getAttribute("title");
  if (title !== null) img.setAttribute("title", title);
  img.setAttribute("loading", "lazy");
  img.setAttribute("decoding", "async");
  img.setAttribute("referrerpolicy", "no-referrer");
  return img;
}

function keepAttribute(tag: string, attr: string, value: string): string | null {
  if (attr === "class") return allowedClass(tag, value);
  if ((tag === "th" || tag === "td") && attr === "data-align") {
    return value === "left" || value === "center" || value === "right" ? value : null;
  }
  if (tag === "div" && attr === "data-alert") return ALERT_TYPES.includes(value as AlertType) ? value : null;
  if (tag === "div" && attr === "data-alert-label") return ALERT_LABEL_SET.has(value) ? value : null;
  if ((tag === "div" || tag === "sup") && attr === "data-label") return safeLabel(value) ? value : null;
  if (attr === "href" && !/^(https?:|mailto:|\/|#)/i.test(value.trim())) return null;
  return value;
}

function cleanNode(node: Node, doc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (["script", "style", "iframe", "object", "embed", "template"].includes(tag)) return null;
  if (tag === "img") return sanitizeImage(el, doc);
  const allowed = ALLOWED[tag];
  if (!allowed) {
    const frag = doc.createDocumentFragment();
    el.childNodes.forEach((c) => {
      const n = cleanNode(c, doc);
      if (n) frag.appendChild(n);
    });
    return frag;
  }
  const out = doc.createElement(tag);
  for (const attr of allowed) {
    const v = el.getAttribute(attr);
    if (v === null) continue;
    if (tag === "input" && attr === "type" && v !== "checkbox") return null;
    const kept = keepAttribute(tag, attr, v);
    if (kept === null) continue;
    if (attr === "href") {
      out.setAttribute("target", "_blank");
      out.setAttribute("rel", "noopener noreferrer");
    }
    out.setAttribute(attr, kept);
  }
  if (tag === "input") out.setAttribute("disabled", "");
  el.childNodes.forEach((c) => {
    const n = cleanNode(c, doc);
    if (n) out.appendChild(n);
  });
  return out;
}

export function sanitizeHtml(html: string): string {
  if (!html) return "";
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const container = document.createElement("div");
  doc.body.childNodes.forEach((c) => {
    const n = cleanNode(c, document);
    if (n) container.appendChild(n);
  });
  return container.innerHTML;
}
