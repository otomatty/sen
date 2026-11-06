import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * 変換中に Tiptap のキー処理が空の更新を流すと、変換中の文字が古い内容で描き直される。
 * ブラウザはその文字のまま IME を確定してしまうので、文書も選択も印もメタもない更新だけを捨てる。
 */
export const CompositionGuard = Extension.create({
  name: "compositionGuard",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("compositionGuard"),
        filterTransaction(tr) {
          if (editor.isDestroyed) return true;
          if (editor.view.composing && !tr.docChanged && !tr.selectionSet && !tr.storedMarksSet && tr.isGeneric) return false;
          return true;
        },
      }),
    ];
  },
});
