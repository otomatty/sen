import { Image } from "@tiptap/extension-image";

function httpSrc(src: unknown): string | null {
  const value = typeof src === "string" ? src.trim() : "";
  return /^https?:/i.test(value) ? value : null;
}

/** 画像。http(s) 以外は読み込まず、代替テキストだけを見せて Markdown には残す */
export const SafeImage = Image.extend({
  renderMarkdown(node) {
    const src = node.attrs?.src ?? "";
    const alt = String(node.attrs?.alt ?? "").replace(/[\[\]]/g, "\\$&");
    const title = node.attrs?.title ?? "";
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
  },
  renderHTML({ node }) {
    const src = httpSrc(node.attrs.src);
    const alt = String(node.attrs.alt ?? "");
    if (!src) return ["span", { class: "md-image-fallback" }, alt];
    const attrs: Record<string, string> = {
      src,
      alt,
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
    };
    if (node.attrs.title) attrs.title = String(node.attrs.title);
    return ["img", attrs];
  },
}).configure({ inline: true, allowBase64: false });
