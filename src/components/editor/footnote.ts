import { InputRule, Node, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { matchFootnoteDefinition, matchFootnoteReference } from "../../../shared/markdown";
import { readBlockTokens } from "./tokens";

function labelOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `[^label]`。中身は編集しない */
export const FootnoteReference = Node.create({
  name: "footnoteReference",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      label: {
        default: "1",
        parseHTML: (element) => element.getAttribute("data-label") ?? element.textContent ?? "1",
        renderHTML: (attributes) => ({ "data-label": attributes.label }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "sup.md-footnote-ref" }];
  },

  renderHTML({ node }) {
    const label = String(node.attrs.label ?? "");
    return ["sup", { class: "md-footnote-ref", "data-label": label }, label];
  },

  renderText({ node }) {
    return `[^${node.attrs.label}]`;
  },

  markdownTokenizer: {
    name: "footnoteReference",
    level: "inline",
    start: (src) => src.indexOf("[^"),
    tokenize(src) {
      const match = matchFootnoteReference(src);
      if (!match) return undefined;
      return { type: "footnoteReference", raw: match.raw, label: match.label };
    },
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode("footnoteReference", { label: labelOf((token as { label?: string }).label) });
  },

  renderMarkdown(node) {
    return `[^${node.attrs?.label ?? ""}]`;
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\^([^\s\]]+)\]$/,
        handler: ({ state, range, match, chain }) => {
          const label = match[1];
          if (!label) return null;
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return null;
          chain()
            .insertContentAt(range, { type: this.name, attrs: { label } })
            .run();
        },
      }),
    ];
  },
});

function indentContinuation(markdown: string): string[] {
  const body = markdown.replace(/\n$/, "");
  const lines = body === "" ? [""] : body.split("\n");
  return lines.map((line, index) => {
    if (index === 0) return line;
    return line.length ? `    ${line}` : "";
  });
}

/** `[^label]: 本文`。書かれた場所に置いたまま */
export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      label: {
        default: "1",
        parseHTML: (element) => element.getAttribute("data-label") ?? "1",
        renderHTML: (attributes) => ({ "data-label": attributes.label }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div.md-footnote" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, class: "md-footnote" }, 0];
  },

  markdownTokenizer: {
    name: "footnoteDefinition",
    level: "block",
    // 段落の直後（空行なし）では定義にしない。リンクの参照定義と同じ。
    // start 自体は残す。無いと marked が段落を 1 文字で切り、中身が空になる。
    start: (src) => {
      const match = /(?:^|\n[ \t]*\n)[ ]{0,3}\[\^[^\s\]]+\]:/.exec(src);
      return match ? match.index : -1;
    },
    tokenize(src, _tokens, lexer) {
      const match = matchFootnoteDefinition(src);
      if (!match) return undefined;
      return {
        type: "footnoteDefinition",
        raw: match.raw,
        label: match.label,
        tokens: readBlockTokens(lexer, match.body),
      };
    },
  },

  parseMarkdown(token, helpers) {
    const label = labelOf((token as { label?: string }).label);
    const parsed = helpers.parseChildren(token.tokens ?? []);
    const content = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).filter(Boolean) as JSONContent[];
    return helpers.createNode("footnoteDefinition", { label }, content.length ? content : [{ type: "paragraph" }]);
  },

  renderMarkdown(node, helpers) {
    const label = String(node.attrs?.label ?? "");
    const children = node.content ?? [];
    const lines: string[] = [];
    children.forEach((child, index) => {
      const rendered = helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
      const parts = indentContinuation(rendered);
      if (index === 0) {
        lines.push(`[^${label}]: ${parts[0] ?? ""}`, ...parts.slice(1));
        return;
      }
      if (lines[lines.length - 1] !== "") lines.push("");
      for (const line of parts) lines.push(line.length ? (line.startsWith("    ") ? line : `    ${line}`) : "");
    });
    return lines.join("\n");
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _old, state) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const { $from } = state.selection;
          if ($from.parent.type.name !== "paragraph") return null;
          const label = definitionLabel($from.parent);
          if (!label) return null;
          const pos = $from.before();
          const definition = state.schema.nodes.footnoteDefinition.create({ label }, state.schema.nodes.paragraph.create());
          let tr = state.tr.replaceWith(pos, pos + $from.parent.nodeSize, definition);
          tr = tr.setSelection(TextSelection.create(tr.doc, pos + 2));
          return tr;
        },
      }),
    ];
  },
});

/** 段落の先頭が `[^label]: ` になったら定義にする */
function definitionLabel(paragraph: ProseMirrorNode): string | null {
  if (paragraph.childCount === 2) {
    const marker = paragraph.child(0);
    const text = paragraph.child(1);
    if (marker.type.name === "footnoteReference" && text.isText && /^:[ \t]$/.test(text.text ?? "")) {
      return labelOf(marker.attrs.label) || null;
    }
  }
  if (paragraph.childCount === 1 && paragraph.firstChild?.isText) {
    const match = /^\[\^([^\s\]]+)\]:[ \t]$/.exec(paragraph.textContent);
    return match?.[1] || null;
  }
  return null;
}
