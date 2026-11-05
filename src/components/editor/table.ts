import { Extension, type Editor } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const ALIGN = ["left", "center", "right"] as const;
export type ColumnAlign = (typeof ALIGN)[number];

function alignAttribute() {
  return {
    default: null as ColumnAlign | null,
    parseHTML: (element: HTMLElement) => {
      const value = (element.getAttribute("data-align") || element.getAttribute("align") || element.style.textAlign || "").toLowerCase();
      return ALIGN.includes(value as ColumnAlign) ? value : null;
    },
    renderHTML: (attributes: { align?: string | null }) => {
      const align = attributes.align;
      if (!ALIGN.includes(align as ColumnAlign)) return {};
      return { "data-align": align };
    },
  };
}

/** セルは段落 1 つ。寄せは data-align で表す（Markdown の列寄せ） */
export const SenTableCell = TableCell.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute() };
  },
});

export const SenTableHeader = TableHeader.extend({
  content: "paragraph",
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute() };
  },
});

export const SenTable = Table.extend({}).configure({ resizable: false });

/** カーソルがある表だけに class を付ける。編集できないときは付けない */
const TableActive = Extension.create({
  name: "tableActive",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("tableActive"),
        props: {
          decorations(state) {
            if (editor.isDestroyed || !editor.isEditable) return DecorationSet.empty;
            const { $from } = state.selection;
            for (let depth = $from.depth; depth > 0; depth--) {
              if ($from.node(depth).type.name !== "table") continue;
              const from = $from.before(depth);
              const node = $from.node(depth);
              return DecorationSet.create(state.doc, [Decoration.node(from, from + node.nodeSize, { class: "table-active" })]);
            }
            return DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export const tableExtensions = [SenTable, TableRow, SenTableHeader, SenTableCell, TableActive];

export function inTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "tableCell" || name === "tableHeader") return true;
  }
  return false;
}

/** `| 見出し |` で始まり `|` で終わる段落を、本文 1 行の表にする */
export function createTableFromPipes(view: EditorView): boolean {
  const { state } = view;
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  if ($from.depth !== 1 || $from.parent.type.name !== "paragraph") return false;
  const cells = pipeCells($from.parent.textContent);
  if (!cells) return false;
  const { schema } = state;
  const paragraph = (text: string) => (text ? schema.nodes.paragraph.create(null, schema.text(text)) : schema.nodes.paragraph.create());
  const headerRow = schema.nodes.tableRow.create(
    null,
    cells.map((text) => schema.nodes.tableHeader.create(null, paragraph(text))),
  );
  const bodyRow = schema.nodes.tableRow.create(
    null,
    cells.map(() => schema.nodes.tableCell.create(null, schema.nodes.paragraph.create())),
  );
  const table = schema.nodes.table.create(null, [headerRow, bodyRow]);
  const from = $from.before();
  let tr = state.tr.replaceWith(from, $from.after(), table);
  const cursor = from + 1 + headerRow.nodeSize + 1 + 1 + 1;
  tr = tr.setSelection(TextSelection.create(tr.doc, cursor)).scrollIntoView();
  view.dispatch(tr);
  return true;
}

function pipeCells(text: string): string[] | null {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  if (!cells.length) return null;
  if (cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells;
}

export interface TableCursor {
  inHeader: boolean;
  columns: number;
  align: ColumnAlign | null;
}

export function tableCursor(editor: Editor): TableCursor | null {
  const { $from } = editor.state.selection;
  let inHeader = false;
  let columns = 0;
  let align: ColumnAlign | null = null;
  let inTable = false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "tableHeader") inHeader = true;
    if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
      const value = node.attrs.align;
      align = ALIGN.includes(value) ? value : null;
    }
    if (node.type.name === "table") {
      columns = node.firstChild?.childCount ?? 0;
      inTable = true;
    }
  }
  return inTable ? { inHeader, columns, align } : null;
}

/** カーソルのある列の寄せを、見出しも含めて揃える */
export function setColumnAlign(editor: Editor, align: ColumnAlign) {
  const { state } = editor;
  const { $from } = state.selection;
  let tableDepth = -1;
  let rowDepth = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "table") tableDepth = depth;
    if (name === "tableRow") rowDepth = depth;
  }
  if (tableDepth < 0 || rowDepth < 0) return;
  const column = $from.index(rowDepth);
  const table = $from.node(tableDepth);
  const tablePos = $from.before(tableDepth);
  let tr = state.tr;
  let rowPos = tablePos + 1;
  table.forEach((row) => {
    let cellPos = rowPos + 1;
    row.forEach((cell, _offset, index) => {
      if (index === column && cell.attrs.align !== align) {
        tr = tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, align });
      }
      cellPos += cell.nodeSize;
    });
    rowPos += row.nodeSize;
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}
