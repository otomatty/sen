import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Columns3,
  Rows3,
  Trash2,
} from "lucide-react";
import { setColumnAlign, tableCursor, type ColumnAlign } from "./table";

const BUTTONS: {
  id: string;
  label: string;
  icon: typeof ArrowUpToLine;
  run: (editor: Editor) => void;
  disabled?: (cursor: NonNullable<ReturnType<typeof tableCursor>>) => boolean;
  pressed?: ColumnAlign;
}[] = [
  {
    id: "table-add-row-before",
    label: "上に行を追加",
    icon: ArrowUpToLine,
    run: (editor) => editor.chain().focus().addRowBefore().run(),
    disabled: (cursor) => cursor.inHeader,
  },
  { id: "table-add-row-after", label: "下に行を追加", icon: ArrowDownToLine, run: (editor) => editor.chain().focus().addRowAfter().run() },
  { id: "table-add-column-before", label: "左に列を追加", icon: ArrowLeftToLine, run: (editor) => editor.chain().focus().addColumnBefore().run() },
  { id: "table-add-column-after", label: "右に列を追加", icon: ArrowRightToLine, run: (editor) => editor.chain().focus().addColumnAfter().run() },
  {
    id: "table-delete-row",
    label: "行を削除",
    icon: Rows3,
    run: (editor) => editor.chain().focus().deleteRow().run(),
    disabled: (cursor) => cursor.inHeader,
  },
  {
    id: "table-delete-column",
    label: "列を削除",
    icon: Columns3,
    run: (editor) => editor.chain().focus().deleteColumn().run(),
    disabled: (cursor) => cursor.columns <= 1,
  },
  { id: "table-align-left", label: "列を左寄せ", icon: AlignLeft, pressed: "left", run: (editor) => setColumnAlign(editor, "left") },
  { id: "table-align-center", label: "列を中央寄せ", icon: AlignCenter, pressed: "center", run: (editor) => setColumnAlign(editor, "center") },
  { id: "table-align-right", label: "列を右寄せ", icon: AlignRight, pressed: "right", run: (editor) => setColumnAlign(editor, "right") },
  { id: "table-delete", label: "表を削除", icon: Trash2, run: (editor) => editor.chain().focus().deleteTable().run() },
];

/** カーソルが表の中にあるとき、表のすぐ上に出す操作バー */
export function TableToolbar({ editor }: { editor: Editor }) {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const cursor = tableCursor(editor);

  useEffect(() => {
    const update = () => {
      if (editor.isDestroyed || !editor.isEditable || !editor.isActive("table")) {
        setBox(null);
        return;
      }
      const table = tableElement(editor);
      const root = editor.view.dom.closest(".editor");
      if (!table || !(root instanceof HTMLElement)) {
        setBox(null);
        return;
      }
      const rootBox = root.getBoundingClientRect();
      const tableBox = table.getBoundingClientRect();
      const top = tableBox.top - rootBox.top + root.scrollTop - 36;
      const left = Math.max(0, tableBox.left - rootBox.left + root.scrollLeft);
      setBox({ top, left });
    };
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("update", update);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("update", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [editor]);

  if (!box || !cursor || !editor.isEditable) return null;
  return (
    <div className="table-toolbar" style={{ top: box.top, left: box.left }} role="toolbar" aria-label="表の操作">
      {BUTTONS.map((button) => {
        const Icon = button.icon;
        const disabled = button.disabled?.(cursor) ?? false;
        const on = button.pressed != null && cursor.align === button.pressed;
        return (
          <button
            key={button.id}
            type="button"
            className={on ? "on" : undefined}
            aria-label={button.label}
            title={button.label}
            data-testid={button.id}
            disabled={disabled}
            aria-pressed={button.pressed ? on : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => button.run(editor)}
          >
            <Icon size={14} />
          </button>
        );
      })}
    </div>
  );
}

function tableElement(editor: Editor): HTMLElement | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name !== "table") continue;
    const dom = editor.view.nodeDOM($from.before(depth));
    return dom instanceof HTMLElement ? dom : null;
  }
  return null;
}
