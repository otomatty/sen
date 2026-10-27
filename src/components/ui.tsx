import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { User } from "../../shared/types";
import { comboLabel, SCOPE, useHotkeys, useOverlayLock } from "../lib/hotkeys";
import { cx, initials } from "../lib/utils";

// ---------------- アバター ----------------
export function Avatar({ user, size = 18, title }: { user?: Pick<User, "name" | "avatarColor"> | null; size?: number; title?: string }) {
  if (!user) {
    return (
      <span className="avatar avatar-empty" style={{ width: size, height: size }} title={title ?? "担当者なし"}>
        <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
          <circle cx="9" cy="7.2" r="2.4" fill="currentColor" opacity="0.7" />
          <path d="M4.6 14.2c.9-2 2.5-3 4.4-3s3.5 1 4.4 3" fill="currentColor" opacity="0.7" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="avatar"
      title={title ?? user.name}
      style={{ width: size, height: size, background: user.avatarColor, fontSize: Math.max(9, size * 0.5) }}
    >
      {initials(user.name)}
    </span>
  );
}

// ---------------- キー表示 ----------------
export function Kbd({ combo, className }: { combo: string; className?: string }) {
  const parts = comboLabel(combo);
  return (
    <span className={cx("kbd-group", className)}>
      {parts.map((p, i) =>
        p === "→" ? (
          <span key={i} className="kbd-then">
            →
          </span>
        ) : (
          <kbd key={i} className="kbd">
            {p}
          </kbd>
        ),
      )}
    </span>
  );
}

// ---------------- ボタン ----------------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, ...rest },
  ref,
) {
  return (
    <button ref={ref} className={cx("btn", `btn-${variant}`, `btn-${size}`, !children && "btn-icon-only", className)} {...rest}>
      {icon}
      {children}
    </button>
  );
});

// ---------------- ツールチップ ----------------
export function Tooltip({
  label,
  combo,
  children,
  side = "bottom",
  delay = 450,
}: {
  label: ReactNode;
  combo?: string;
  children: ReactNode;
  side?: "bottom" | "top" | "right";
  delay?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => {
    timer.current = setTimeout(() => {
      const el = (ref.current?.firstElementChild as HTMLElement | null) ?? ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (side === "right") setPos({ x: r.right + 8, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: side === "top" ? r.top - 6 : r.bottom + 6 });
    }, delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setPos(null);
  };
  useEffect(() => hide, []);
  return (
    <span ref={ref} className="tooltip-anchor" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div className={cx("tooltip", `tooltip-${side}`)} style={{ left: pos.x, top: pos.y }} role="tooltip">
            <span>{label}</span>
            {combo && <Kbd combo={combo} />}
          </div>,
          document.body,
        )}
    </span>
  );
}

// ---------------- ポップオーバー ----------------
export function Popover({
  anchor,
  onClose,
  children,
  className,
  placement = "bottom-start",
  width,
  testId,
}: {
  anchor: DOMRect | { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  placement?: "bottom-start" | "bottom-end" | "right-start" | "center";
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 位置を測るまでは画面外に置く（visibility:hidden にすると中の入力欄に autoFocus が効かない）
  const [style, setStyle] = useState<CSSProperties>({ left: -10000, top: -10000 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!anchor || placement === "center") {
      setStyle({ left: Math.max(8, (vw - w) / 2), top: Math.max(8, vh * 0.18) });
      return;
    }
    const r = "width" in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    let left = placement === "bottom-end" ? r.right - w : placement === "right-start" ? r.right + 4 : r.left;
    let top = placement === "right-start" ? r.top - 4 : r.bottom + 4;
    if (left + w > vw - 8) left = vw - w - 8;
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = Math.max(8, (placement === "right-start" ? vh - h - 8 : r.top - h - 4));
    setStyle({ left, top });
  }, [anchor, placement]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // 別のポップオーバー内のクリックは無視
        const t = e.target as HTMLElement;
        if (t.closest?.(".popover")) return;
        // 開閉ボタン自身のクリックは、ボタン側のトグル処理に任せる
        if (t.closest?.("[data-popover-anchor]")) return;
        onClose();
      }
    };
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  useHotkeys("escape", () => onClose(), { allowInInput: true, scope: SCOPE.overlay + 10 });
  useOverlayLock();

  return createPortal(
    <>
      {(!anchor || placement === "center") && <div className="popover-backdrop" onMouseDown={onClose} />}
      <div
        ref={ref}
        className={cx("popover", className, (!anchor || placement === "center") && "popover-center")}
        style={{ ...style, width }}
        data-testid={testId}
        onKeyDown={(e) => {
          // ポップオーバー内のキー入力はグローバルショートカットに渡さない
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          e.stopPropagation();
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

// ---------------- モーダル ----------------
export function Modal({
  onClose,
  children,
  className,
  width = 560,
  testId,
  align = "top",
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number | string;
  testId?: string;
  align?: "top" | "center";
}) {
  useHotkeys("escape", () => onClose(), { allowInInput: true, scope: SCOPE.overlay });
  useOverlayLock();
  return createPortal(
    <div className={cx("modal-root", align === "center" && "modal-center")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", className)} style={{ width }} role="dialog" aria-modal="true" data-testid={testId}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------------- メニュー ----------------
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  combo?: string;
  danger?: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export function Menu({
  anchor,
  items,
  onClose,
  placement,
}: {
  anchor: DOMRect | { x: number; y: number } | null;
  items: (MenuItem | "divider")[];
  onClose: () => void;
  placement?: "bottom-start" | "bottom-end";
}) {
  const [active, setActive] = useState(0);
  const selectable = items.filter((i): i is MenuItem => i !== "divider" && !i.disabled);
  useHotkeys(
    ["arrowdown", "arrowup", "enter"],
    (e) => {
      if (e.key === "ArrowDown") setActive((a) => (a + 1) % selectable.length);
      else if (e.key === "ArrowUp") setActive((a) => (a - 1 + selectable.length) % selectable.length);
      else {
        selectable[active]?.onSelect();
        onClose();
      }
    },
    { scope: SCOPE.overlay + 5 },
  );
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu" placement={placement}>
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            className={cx("menu-item", item.danger && "danger", selectable[active] === item && "active")}
            disabled={item.disabled}
            onMouseEnter={() => setActive(selectable.indexOf(item))}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <span className="menu-item-icon">{item.icon}</span>
            <span className="menu-item-label">{item.label}</span>
            {item.combo && <Kbd combo={item.combo} />}
          </button>
        ),
      )}
    </Popover>
  );
}

// ---------------- 空状態 ----------------
export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {description && <div className="empty-desc">{description}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// ---------------- 自動で高さが伸びるテキストエリア ----------------
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }
>(function AutoTextarea(props, outerRef) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return (
    <textarea
      {...props}
      rows={1}
      ref={(el) => {
        inner.current = el;
        if (typeof outerRef === "function") outerRef(el);
        else if (outerRef) outerRef.current = el;
      }}
    />
  );
});

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx("switch", checked && "on")}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}
