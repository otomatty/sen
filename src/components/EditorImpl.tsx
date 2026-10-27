import { useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor as TiptapEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Extension } from "@tiptap/core";
import { cx } from "../lib/utils";

// リッチテキストエディタ（Markdown 記法の入力ショートカットに対応）
//   "# " 見出し / "- " 箇条書き / "1. " 番号付き / "[] " チェックリスト / "```" コード / "> " 引用
export interface EditorProps {
  value: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onBlur?: () => void;
  className?: string;
  editable?: boolean;
  testId?: string;
  editorRef?: React.MutableRefObject<TiptapEditor | null>;
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

  const editor = useEditor({
    immediatelyRender: true,
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
      }),
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
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor }) => {
      const html = editor.isEmpty ? "" : editor.getHTML();
      onChangeRef.current?.(html);
    },
    onBlur: () => onBlurRef.current?.(),
    editorProps: {
      attributes: {
        class: "prose",
        ...(testId ? { "data-testid": testId } : {}),
      },
    },
  });

  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // 外部（他のユーザーなど）からの変更を、編集中でなければ反映する
  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused) return;
    try {
      const current = editor.isEmpty ? "" : editor.getHTML();
      if ((value || "") !== current) editor.commands.setContent(value || "", { emitUpdate: false });
    } catch {
      // 破棄の途中など、反映できないときは次の更新で反映する
    }
  }, [value, editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(editable);
  }, [editable, editor]);

  return <EditorContent editor={editor} className={cx("editor", className)} />;
}
