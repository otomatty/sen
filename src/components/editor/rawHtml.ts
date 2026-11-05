import { Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { matchInlineHtml } from "../../../shared/markdown";

/** ブロックの生 HTML。コードブロックのように、元の文字列をそのまま編集する */
export const RawHtmlBlock = Node.create({
  name: "rawHtmlBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  parseHTML() {
    return [{ tag: "pre.md-raw-html", preserveWhitespace: "full" }];
  },

  renderHTML() {
    return ["pre", { class: "md-raw-html" }, ["code", {}, 0]];
  },

  markdownTokenName: "html",

  parseMarkdown(token, helpers) {
    const raw = String(token.raw ?? token.text ?? "").replace(/(?:\r?\n)+$/, "");
    if (!raw) return [];
    return helpers.createNode("rawHtmlBlock", undefined, [helpers.createTextNode(raw)]);
  },

  renderMarkdown(node) {
    return (node.content ?? []).map((child) => child.text ?? "").join("");
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.isComposing || event.keyCode === 229) return false;
            if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return false;
            return insertNewlineInRawHtml(view);
          },
        },
      }),
    ];
  },
});

function insertNewlineInRawHtml(view: EditorView): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type.name !== "rawHtmlBlock") return false;
  view.dispatch(view.state.tr.insertText("\n").scrollIntoView());
  return true;
}

/**
 * 行内の生 HTML。marked の標準 html トークンより先に受け取り、
 * エディタの部品に分解されないようにする。
 */
export const InlineHtml = Node.create({
  name: "inlineHtml",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "code.md-raw-html",
        getAttrs: (element) => {
          const parent = element.parentElement;
          if (parent?.tagName === "PRE" && parent.classList.contains("md-raw-html")) return false;
          return { raw: element.textContent ?? "" };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return ["code", { class: "md-raw-html" }, String(node.attrs.raw ?? "")];
  },

  renderText({ node }) {
    return String(node.attrs.raw ?? "");
  },

  markdownTokenizer: {
    name: "inlineHtml",
    level: "inline",
    start: (src) => src.indexOf("<"),
    tokenize(src) {
      const match = matchInlineHtml(src);
      if (!match) return undefined;
      return { type: "inlineHtml", raw: match.raw, text: match.raw };
    },
  },

  parseMarkdown(token, helpers) {
    const raw = String(token.raw ?? token.text ?? "");
    if (!raw) return [];
    return helpers.createNode("inlineHtml", { raw });
  },

  renderMarkdown(node) {
    return String(node.attrs?.raw ?? "");
  },
});
