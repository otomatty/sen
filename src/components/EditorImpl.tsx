import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Marked, marked as markedFn } from "marked";
import type { EditorView } from "@tiptap/pm/view";
import { cx } from "../lib/utils";
import { Alert } from "./editor/alert";
import { FootnoteDefinition, FootnoteReference } from "./editor/footnote";
import { SafeImage } from "./editor/image";
import { InlineHtml, RawHtmlBlock } from "./editor/rawHtml";
import { TableToolbar } from "./editor/TableToolbar";
import { adjustEmphasisPunctuation } from "./editor/emphasis";
import { createTableFromPipes, inTableCell, tableExtensions } from "./editor/table";

// リッチテキストエディタ。本文は GitHub 互換の Markdown（GFM）として読み書きする。
//   "# " 見出し / "- " 箇条書き / "1. " 番号付き / "[] " チェックリスト / "```" コード / "> " 引用
//   "| a | b |" のあとの Enter で表 / "> [!NOTE]" で注記 / "[^1]" で脚注
export interface EditorProps {
  value: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onBlur?: () => void;
  className?: string;
  editable?: boolean;
  testId?: string;
  editorRef?: React.MutableRefObject<TiptapEditor | null>;
}

/** 末尾の改行は取り除く。ただし Shift+Enter のハードブレーク（空白 2 つ、または \）は残す */
export function editorMarkdown(editor: TiptapEditor): string {
  if (editor.isEmpty) return "";
  // 画面の文書は変えず、保存する文字だけ句読点の印を外す。getMarkdown は serialize(getJSON()) と同じ。
  const json = adjustEmphasisPunctuation(editor.getJSON());
  const markdown = editor.markdown ? editor.markdown.serialize(json) : editor.getMarkdown();
  return markdown.replace(/\n+$/, (newlines) => {
    const before = markdown.slice(0, markdown.length - newlines.length);
    if (before.endsWith("  ") || before.endsWith("\\")) return "\n";
    return "";
  });
}

export default function EditorImpl({
  value,
  onChange,
  placeholder,
  autoFocus,
  onSubmit,
  onBlur,
  className,
  editable = true,
  testId,
  editorRef,
}: EditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  // 最後に親へ出した文字列か、最後に読み込んだ value。getMarkdown() とは比べない
  const synced = useRef(value || "");
  const instance = useRef<TiptapEditor | null>(null);
  const [marked] = useState(() => new Marked());

  const editor = useEditor({
    immediatelyRender: true,
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        underline: false,
        trailingNode: false,
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
      Markdown.configure({
        // 拡張の型は marked 関数を要求するが、実行時は Marked のインスタンス（setOptions / use / Lexer）で動く。
        // 表示用の marked とは別のインスタンスにする（Tiptap がトークナイザを登録するため）
        marked: marked as unknown as typeof markedFn,
        markedOptions: { gfm: true, breaks: true },
      }),
      ...tableExtensions,
      SafeImage,
      Alert,
      FootnoteReference,
      FootnoteDefinition,
      RawHtmlBlock,
      InlineHtml,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
      Extension.create({
        name: "senKeys",
        addKeyboardShortcuts() {
          return {
            "Mod-Enter": () => {
              if (onSubmitRef.current) {
                onSubmitRef.current();
                return true;
              }
              return false;
            },
            Escape: () => {
              this.editor.commands.blur();
              return true;
            },
          };
        },
      }),
    ],
    content: value || "",
    contentType: "markdown",
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.docChanged) return;
      const markdown = editorMarkdown(editor);
      if (markdown === synced.current) return;
      synced.current = markdown;
      onChangeRef.current?.(markdown);
    },
    onBlur: () => onBlurRef.current?.(),
    editorProps: {
      attributes: {
        class: "prose",
        ...(testId ? { "data-testid": testId } : {}),
      },
      handleKeyDown(view, event) {
        if (event.isComposing || event.keyCode === 229) return false;
        if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return false;
        if (inTableCell(view.state)) {
          event.preventDefault();
          return true;
        }
        if (!event.shiftKey && createTableFromPipes(view)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handlePaste(view, event) {
        return pasteMarkdown(view, event, () => instance.current);
      },
      handleDrop(_view, event) {
        if (event.dataTransfer?.files?.length) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
  });

  instance.current = editor;
  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // 外部（他のユーザーなど）からの変更を、編集中でなければ反映する
  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused) return;
    const next = value || "";
    if (next === synced.current) return;
    try {
      editor.commands.setContent(next, { contentType: "markdown", emitUpdate: false });
      synced.current = next;
    } catch {
      // 破棄の途中など、反映できないときは次の更新で反映する
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(editable);
  }, [editable, editor]);

  return (
    <div className={cx("editor", className)}>
      {editor && <TableToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

function inCode(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth >= 0; depth--) {
    if ($from.node(depth).type.spec.code) return true;
  }
  return false;
}

/** 文字だけの貼り付けは Markdown として読む。画像ファイルは捨てる。コードの中は文字のまま */
function pasteMarkdown(view: EditorView, event: ClipboardEvent, getEditor: () => TiptapEditor | null): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const files = Array.from(data.files);
  const html = data.getData("text/html").trim();
  const text = data.getData("text/plain");
  if (files.some((file) => file.type.startsWith("image/")) && !html && !text) {
    event.preventDefault();
    return true;
  }
  if (inCode(view)) {
    event.preventDefault();
    if (text) view.dispatch(view.state.tr.insertText(text).scrollIntoView());
    return true;
  }
  if (!html && text) {
    const editor = getEditor();
    if (!editor) return false;
    event.preventDefault();
    editor.commands.insertContent(text, { contentType: "markdown" });
    return true;
  }
  return false;
}
