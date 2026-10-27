// 表示専用の HTML サニタイザ（許可リスト方式）。
// エディタ（Tiptap）が出力する要素だけを残し、それ以外は中身のテキストだけにする。

const ALLOWED: Record<string, string[]> = {
  p: [],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  s: [],
  u: [],
  code: [],
  pre: [],
  ul: ["data-type"],
  ol: ["start"],
  li: ["data-type", "data-checked"],
  blockquote: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  hr: [],
  a: ["href"],
  label: [],
  span: [],
  div: [],
  input: ["type", "checked", "disabled"],
};

function cleanNode(node: Node, doc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (["script", "style", "iframe", "object", "embed", "template"].includes(tag)) return null;
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
    if (attr === "href") {
      if (!/^(https?:|mailto:|\/|#)/i.test(v.trim())) continue;
      out.setAttribute("target", "_blank");
      out.setAttribute("rel", "noopener noreferrer");
    }
    if (tag === "input" && attr === "type" && v !== "checkbox") return null;
    out.setAttribute(attr, v);
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
