import { useRef, useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { ArrowUp } from "lucide-react";
import { addComment } from "../../store/actions";
import { useMembers } from "../../store/selectors";
import { cx, fuzzyMatch, isHtmlEmpty, MOD } from "../../lib/utils";
import { Editor } from "../../components/Editor";
import { Avatar } from "../../components/ui";

export function CommentComposer({ issueId }: { issueId: string }) {
  const [html, setHtml] = useState("");
  const [key, setKey] = useState(0);
  const editorRef = useRef<TiptapEditor | null>(null);
  const members = useMembers();
  const [mention, setMention] = useState<{ q: string; from: number; to: number; active: number } | null>(null);

  const candidates = mention ? members.filter((m) => fuzzyMatch(`${m.name} ${m.email}`, mention.q)).slice(0, 6) : [];

  const detectMention = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const { from } = ed.state.selection;
    const $from = ed.state.selection.$from;
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
    const m = /(?:^|\s)@([^\s@]{0,20})$/.exec(textBefore);
    if (m) setMention({ q: m[1], from: from - m[1].length - 1, to: from, active: 0 });
    else setMention(null);
  };

  const insertMention = (name: string) => {
    const ed = editorRef.current;
    if (!ed || !mention) return;
    ed.chain().focus().deleteRange({ from: mention.from, to: mention.to }).insertContent(`@${name} `).run();
    setMention(null);
  };

  const submit = () => {
    if (isHtmlEmpty(html)) return;
    addComment(issueId, html);
    setHtml("");
    setKey((k) => k + 1);
    setMention(null);
  };

  return (
    <div
      className="composer"
      data-testid="comment-composer"
      onKeyDownCapture={(e) => {
        if (!mention || !candidates.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          const d = e.key === "ArrowDown" ? 1 : -1;
          setMention({ ...mention, active: (mention.active + d + candidates.length) % candidates.length });
        } else if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          insertMention(candidates[mention.active].name);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setMention(null);
        }
      }}
    >
      <Editor
        key={key}
        value=""
        editorRef={editorRef}
        placeholder="コメントを書く…（@ でメンバーをメンション）"
        onChange={(h) => {
          setHtml(h);
          detectMention();
        }}
        onSubmit={submit}
        className="composer-editor"
        testId="comment-input"
      />
      {mention && candidates.length > 0 && (
        <div className="mention-menu" data-testid="mention-menu">
          {candidates.map((m, i) => (
            <button
              key={m.id}
              className={cx("picker-item", i === mention.active && "active")}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m.name);
              }}
            >
              <Avatar user={m} size={16} />
              <span className="picker-label">{m.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-actions">
        <span className="muted small">{MOD} + Enter で送信</span>
        <button className="send-btn" onClick={submit} disabled={isHtmlEmpty(html)} aria-label="コメントを送信" data-testid="comment-submit">
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}
