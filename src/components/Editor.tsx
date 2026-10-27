import { lazy, Suspense } from "react";
import { cx } from "../lib/utils";
import { sanitizeHtml } from "../lib/sanitize";
import type { EditorProps } from "./EditorImpl";
import { ErrorBoundary } from "./ErrorBoundary";

// エディタ（Tiptap）は大きいので、必要になったときに読み込む。
// アプリ起動後の空き時間に先読みするため、実際に開くときには待ち時間はほぼない。
const Impl = lazy(() => import("./EditorImpl"));

let preloaded: Promise<unknown> | null = null;
export function preloadEditor() {
  if (!preloaded) preloaded = import("./EditorImpl");
  return preloaded;
}

function Fallback({ value, placeholder, className, testId }: EditorProps) {
  return (
    <div className={cx("editor", className)}>
      {value ? (
        <div className="prose" data-testid={testId} dangerouslySetInnerHTML={{ __html: sanitizeHtml(value) }} />
      ) : (
        <div className="prose" data-testid={testId}>
          <p className="is-editor-empty editor-fallback-empty" data-placeholder={placeholder ?? ""} />
        </div>
      )}
    </div>
  );
}

export function Editor(props: EditorProps) {
  return (
    <ErrorBoundary fallback={() => <Fallback {...props} />}>
      <Suspense fallback={<Fallback {...props} />}>
        <Impl {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
