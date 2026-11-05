import { Node, type JSONContent, type MarkdownToken } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { ALERT_LABELS, ALERT_TYPES, type AlertType, matchAlert } from "../../../shared/markdown";
import { readBlockTokens } from "./tokens";

const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\]$/i;

function alertType(value: string | null | undefined): AlertType | null {
  const kind = value?.toLowerCase();
  return ALERT_TYPES.includes(kind as AlertType) ? (kind as AlertType) : null;
}

function prefixQuote(markdown: string): string {
  const body = markdown.replace(/\n$/, "");
  if (!body) return ">";
  return body
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
}

/** GitHub の注記（`> [!NOTE]` など）。中身は複数のブロック */
export const Alert = Node.create({
  name: "alert",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (element) => alertType(element.getAttribute("data-alert")) ?? "note",
        renderHTML: (attributes) => {
          const type = alertType(attributes.type) ?? "note";
          return {
            class: "md-alert",
            "data-alert": type,
            "data-alert-label": ALERT_LABELS[type],
          };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "div.md-alert" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes, 0];
  },

  markdownTokenizer: {
    name: "alert",
    level: "block",
    start: (src) => {
      const match = /(?:^|\n)[ ]{0,3}> ?\[!(?:note|tip|important|warning|caution)\]/i.exec(src);
      return match ? match.index : -1;
    },
    tokenize(src, _tokens, lexer) {
      const match = matchAlert(src);
      if (!match) return undefined;
      return {
        type: "alert",
        raw: match.raw,
        alert: match.type,
        tokens: readBlockTokens(lexer, match.body),
      };
    },
  },

  parseMarkdown(token, helpers) {
    const type = alertType(String((token as MarkdownToken & { alert?: string }).alert ?? "")) ?? "note";
    const parsed = helpers.parseChildren(token.tokens ?? []);
    const content = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter(Boolean) as JSONContent[];
    return helpers.createNode("alert", { type }, content.length ? content : [{ type: "paragraph" }]);
  },

  renderMarkdown(node, helpers) {
    const type = (alertType(node.attrs?.type) ?? "note").toUpperCase();
    const children = node.content ?? [];
    const parts = [`> [!${type}]`];
    children.forEach((child, index) => {
      if (index > 0) parts.push(">");
      parts.push(prefixQuote(helpers.renderChild?.(child, index) ?? helpers.renderChildren([child])));
    });
    return parts.join("\n");
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.isComposing || event.keyCode === 229) return false;
            if (event.key === "Backspace") return unwrapEmptyAlert(view);
            if (event.key !== "Enter" && event.key !== " ") return false;
            if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
            return convertBlockquoteToAlert(view);
          },
        },
      }),
    ];
  },
});

function blockquoteDepth($pos: { depth: number; node: (depth: number) => ProseMirrorNode }): number {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "blockquote") return depth;
  }
  return -1;
}

/** 引用の最初の段落が `[!NOTE]` だけのとき、スペースか Enter で注記にする */
function convertBlockquoteToAlert(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  const depth = blockquoteDepth($from);
  if (depth < 0) return false;
  const quote = $from.node(depth);
  const first = quote.firstChild;
  if (!first || first.type.name !== "paragraph" || $from.parent !== first) return false;
  const marker = ALERT_MARKER.exec(first.textContent);
  if (!marker) return false;
  const type = marker[1].toLowerCase();
  const rest: ProseMirrorNode[] = [];
  for (let i = 1; i < quote.childCount; i++) rest.push(quote.child(i));
  if (!rest.length) rest.push(state.schema.nodes.paragraph.create());
  const alert = state.schema.nodes.alert.create({ type }, rest);
  const pos = $from.before(depth);
  let tr = state.tr.replaceWith(pos, pos + quote.nodeSize, alert);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

/** 中身が空の注記の先頭で Backspace すると、普通の段落に戻る */
function unwrapEmptyAlert(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  let depth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "alert") {
      depth = d;
      break;
    }
  }
  if (depth < 0 || $from.parentOffset !== 0) return false;
  const alert = $from.node(depth);
  if (alert.childCount !== 1) return false;
  const only = alert.firstChild;
  if (!only || only.type.name !== "paragraph" || only.content.size !== 0) return false;
  if ($from.parent !== only) return false;
  const pos = $from.before(depth);
  const paragraph = state.schema.nodes.paragraph.create();
  let tr = state.tr.replaceWith(pos, pos + alert.nodeSize, paragraph);
  tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView();
  view.dispatch(tr);
  return true;
}
