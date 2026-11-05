import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { ChevronsUpDown, Download, LogOut, Monitor, Moon, RefreshCw, Sparkles, Sun, User } from "lucide-react";
import type { Me } from "../../shared/types";
import { Avatar, Popover } from "../components/ui";
import { cx } from "../lib/utils";
import { useData } from "../store/data";
import { setTheme, useUI, type Theme } from "../store/ui";
import { useWsPath } from "./hooks";
import { applyUpdate, installApp, usePWA } from "./pwa";
import { logout } from "./session";

const THEMES: { id: Theme; label: string }[] = [
  { id: "system", label: "システム" },
  { id: "light", label: "ライト" },
  { id: "dark", label: "ダーク" },
];

function menuEntries(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].filter((el) => {
    if (el.getAttribute("aria-disabled") === "true") return false;
    return !("disabled" in el && (el as HTMLButtonElement).disabled);
  });
}

export function UserMenu() {
  const p = useWsPath();
  const navigate = useNavigate();
  const me = useData((s) => (s.meId ? (s.users[s.meId] as Me) : null));
  const syncStatus = useData((s) => s.syncStatus);
  const pendingCount = useData((s) => s.pendingCount);
  const realtime = useData((s) => s.realtime);
  const theme = useUI((s) => s.theme);
  const canInstall = usePWA((s) => !!s.installPrompt);
  const updateReady = usePWA((s) => s.updateReady);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const open = rect !== null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const isDemo = typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__;
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  const close = () => setRect(null);

  useLayoutEffect(() => {
    if (rect) {
      profileRef.current?.focus({ preventScroll: true });
      return;
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [rect]);

  const go = (to: string) => {
    navigate(p(to));
    useUI.setState({ sidebarOpen: false });
    close();
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = menuRef.current;
    if (!root) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const items = menuEntries(root);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next = 0;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
      else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      restoreFocus.current = true;
      buttonRef.current?.focus({ preventScroll: true });
      close();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      restoreFocus.current = true;
      buttonRef.current?.focus({ preventScroll: true });
      close();
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        className={cx("user-button", open && "open")}
        data-testid="user-menu"
        data-popover-anchor
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={me ? `${me.name} のアカウント` : "アカウント"}
        title={me?.name}
        onClick={() => {
          if (open) {
            close();
            return;
          }
          const el = buttonRef.current;
          if (el) setRect(el.getBoundingClientRect());
        }}
      >
        <span className="user-avatar-wrap">
          <Avatar user={me} size={24} />
          {updateReady && <span className="user-update-dot" />}
        </span>
        <span className="user-button-text">
          <span className="user-button-name">{me?.name}</span>
          <span
            className={cx("sync-status", syncStatus)}
            data-testid="sync-status"
            data-realtime={realtime ? "on" : "off"}
            title={
              syncStatus === "offline"
                ? `${pendingCount}件の変更をこの端末に保持しています。接続が戻ると送信します`
                : realtime
                  ? "変更はリアルタイムで共有されています"
                  : "定期的に同期しています"
            }
          >
            <span className="sync-dot" />
            <span className="sync-text">
              {syncStatus === "offline"
                ? `オフライン（${pendingCount}件を保持中）`
                : syncStatus === "syncing"
                  ? "同期中…"
                  : "同期済み"}
            </span>
          </span>
        </span>
        <ChevronsUpDown size={14} className="user-button-chevron" />
      </button>
      {rect && (
        <Popover anchor={rect} onClose={close} className="menu user-menu" placement="top-start" width={264} testId="user-menu-popover">
          <div ref={menuRef} role="menu" aria-label="アカウントのメニュー" onKeyDown={onMenuKeyDown}>
            <div className="user-menu-head">
              <Avatar user={me} size={32} />
              <span className="user-menu-id">
                <span className="user-menu-name">{me?.name}</span>
                <span className="user-menu-email">{me?.email}</span>
              </span>
            </div>
            <div className="menu-divider" role="separator" />
            <button ref={profileRef} role="menuitem" className="menu-item" data-testid="user-menu-profile" onClick={() => go("/settings/profile")}>
              <span className="menu-item-icon">
                <User size={14} />
              </span>
              <span className="menu-item-label">個人設定</span>
            </button>
            {!isDemo && (
              <button role="menuitem" className="menu-item" data-testid="user-menu-ai" onClick={() => go("/settings/ai")}>
                <span className="menu-item-icon">
                  <Sparkles size={14} />
                </span>
                <span className="menu-item-label">AI 連携</span>
              </button>
            )}
            <div className="menu-divider" role="separator" />
            <div className="user-menu-theme" role="group" aria-label="テーマ">
              <span className="menu-item-icon">
                <ThemeIcon size={14} />
              </span>
              <span className="user-menu-theme-label">テーマ</span>
              <div className="segmented">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    role="menuitemradio"
                    aria-checked={theme === t.id}
                    className={cx(theme === t.id && "on")}
                    data-testid={`user-menu-theme-${t.id}`}
                    onClick={() => setTheme(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            {canInstall && (
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  close();
                  void installApp();
                }}
              >
                <span className="menu-item-icon">
                  <Download size={14} />
                </span>
                <span className="menu-item-label">アプリをインストール</span>
              </button>
            )}
            {updateReady && (
              <button
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  close();
                  void applyUpdate();
                }}
              >
                <span className="menu-item-icon">
                  <RefreshCw size={14} />
                </span>
                <span className="menu-item-label">新しいバージョンに更新</span>
                <span className="menu-new-dot" aria-hidden />
              </button>
            )}
            <div className="menu-divider" role="separator" />
            <button
              role="menuitem"
              className="menu-item"
              data-testid="user-menu-logout"
              onClick={() => {
                close();
                void logout();
              }}
            >
              <span className="menu-item-icon">
                <LogOut size={14} />
              </span>
              <span className="menu-item-label">ログアウト</span>
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
