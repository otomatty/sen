import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { cx, fuzzyMatch } from "../lib/utils";
import { SCOPE, useHotkeys } from "../lib/hotkeys";
import { Popover } from "./ui";

export interface PickerOption {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: ReactNode;
  keywords?: string;
  selected?: boolean;
  /** 数字キーで選べるようにする（0〜9） */
  digit?: number;
  section?: string;
}

export function Picker({
  anchor,
  onClose,
  options,
  placeholder,
  multi,
  onSelect,
  onCreate,
  createLabel,
  header,
  testId,
  width = 280,
  emptyText = "見つかりません",
  footer,
}: {
  anchor: DOMRect | null | undefined;
  onClose: () => void;
  options: PickerOption[];
  placeholder: string;
  multi?: boolean;
  onSelect: (opt: PickerOption) => void;
  onCreate?: (query: string) => void;
  createLabel?: (q: string) => string;
  header?: ReactNode;
  testId?: string;
  width?: number;
  emptyText?: string;
  footer?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 開いた直後に確実に入力欄へフォーカスする（すぐに文字を打てるように）
  useEffect(() => {
    inputRef.current?.focus();
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const filtered = useMemo(
    () => options.filter((o) => fuzzyMatch(`${o.label} ${o.keywords ?? ""}`, q)),
    [options, q],
  );
  const canCreate = !!onCreate && q.trim() && !options.some((o) => o.label === q.trim());
  const total = filtered.length + (canCreate ? 1 : 0);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    // 初期フォーカスは選択中の項目へ
    if (!multi) {
      const i = filtered.findIndex((o) => o.selected);
      if (i >= 0) setActive(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    if (i < filtered.length) {
      onSelect(filtered[i]);
      if (!multi) onClose();
    } else if (canCreate) {
      onCreate!(q.trim());
      setQ("");
    }
  };

  useHotkeys("escape", () => onClose(), { allowInInput: true, scope: SCOPE.overlay + 20 });

  let lastSection: string | undefined;
  return (
    <Popover anchor={anchor ?? null} onClose={onClose} className="picker" width={width} testId={testId}>
      {header && <div className="picker-header">{header}</div>}
      <div className="picker-search">
        <input
          ref={inputRef}
          autoFocus
          value={q}
          placeholder={placeholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (total ? (a + 1) % total : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (total ? (a - 1 + total) % total : 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (/^\d$/.test(e.key) && !q) {
              const opt = options.find((o) => o.digit === Number(e.key));
              if (opt) {
                e.preventDefault();
                onSelect(opt);
                if (!multi) onClose();
              }
            }
          }}
        />
      </div>
      <div className="picker-list" ref={listRef} role="listbox">
        {filtered.map((o, i) => {
          const showSection = o.section && o.section !== lastSection;
          lastSection = o.section;
          return (
            <div key={o.id}>
              {showSection && <div className="picker-section">{o.section}</div>}
              <button
                data-index={i}
                role="option"
                aria-selected={!!o.selected}
                className={cx("picker-item", i === active && "active")}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {multi && <span className={cx("checkbox", o.selected && "checked")}>{o.selected && <Check size={11} strokeWidth={3} />}</span>}
                {o.icon && <span className="picker-icon">{o.icon}</span>}
                <span className="picker-label">{o.label}</span>
                {o.hint && <span className="picker-hint">{o.hint}</span>}
                {!multi && o.selected && <Check size={14} className="picker-check" />}
                {o.digit !== undefined && <span className="picker-digit">{o.digit}</span>}
              </button>
            </div>
          );
        })}
        {canCreate && (
          <button
            data-index={filtered.length}
            className={cx("picker-item", active === filtered.length && "active")}
            onMouseMove={() => setActive(filtered.length)}
            onClick={() => choose(filtered.length)}
          >
            <span className="picker-icon">
              <Plus size={14} />
            </span>
            <span className="picker-label">{createLabel ? createLabel(q.trim()) : `「${q.trim()}」を作成`}</span>
          </button>
        )}
        {!total && <div className="picker-empty">{emptyText}</div>}
      </div>
      {footer}
    </Popover>
  );
}
