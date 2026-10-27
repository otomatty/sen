import { useEffect, useRef } from "react";
import { isMac } from "./utils";

// キーボードショートカットの仕組み。
// - 後からマウントされたハンドラが優先（モーダル > 詳細画面 > 一覧 > グローバル）
// - 入力欄にフォーカスがあるときは、allowInInput を指定したものだけが動く
// - "g i" のような 2 打鍵のシーケンスにも対応

type Handler = (e: KeyboardEvent) => unknown;

interface Binding {
  id: number;
  keys: string[]; // 正規化済み（例: "mod+k", "shift+p", "g i"）
  handler: { current: Handler };
  allowInInput: boolean;
  enabled: { current: boolean };
  scope: number;
}

let nextId = 1;
const bindings: Binding[] = [];
let pendingPrefix: string | null = null;
let prefixTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
// モーダルやポップオーバーが開いている間は、その下の画面のショートカットを止める
let overlayDepth = 0;

function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  const out: string[] = [];
  if (mods.has("mod")) out.push("mod");
  if (mods.has("ctrl")) out.push("ctrl");
  if (mods.has("alt")) out.push("alt");
  if (mods.has("shift")) out.push("shift");
  out.push(key);
  return out.join("+");
}

const SYMBOL_KEYS = new Set(["?", "/", ".", ",", "[", "]", "-", "=", ";", "'", "\\", "`", "<", ">", "!", "@", "#"]);

const CODE_CHAR: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Backquote: "`",
};

function eventCombo(e: KeyboardEvent): string {
  let key = e.key;
  if (key === " ") key = "space";
  // 修飾キー付きの記号は、キーボード配列の違いに左右されないよう物理キーで判定する（⌘⇧. など）
  const withMod = e.metaKey || e.ctrlKey || e.altKey;
  if (withMod && CODE_CHAR[e.code]) {
    const out: string[] = [];
    if (isMac ? e.metaKey : e.ctrlKey) out.push("mod");
    if (isMac && e.ctrlKey) out.push("ctrl");
    if (e.altKey) out.push("alt");
    if (e.shiftKey) out.push("shift");
    out.push(CODE_CHAR[e.code]);
    return out.join("+");
  }
  // Alt を押すと Mac では別の文字になるため、英字は物理キーから判定する
  if (e.code?.startsWith("Key") && (e.altKey || !/^[a-zA-Z]$/.test(key))) key = e.code.slice(3);
  if (e.code?.startsWith("Digit") && e.altKey) key = e.code.slice(5);
  key = key.toLowerCase();
  const out: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) out.push("mod");
  if (isMac && e.ctrlKey) out.push("ctrl");
  if (e.altKey) out.push("alt");
  if (e.shiftKey && !SYMBOL_KEYS.has(key)) out.push("shift");
  out.push(key);
  return out.join("+");
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return; // IME 変換中
  if (e.defaultPrevented) return;
  const combo = eventCombo(e);
  if (["shift", "control", "alt", "meta", "mod"].includes(combo.split("+").pop() ?? "")) return;
  const typing = isTypingTarget(e.target);
  const candidates: string[] = [];
  if (pendingPrefix) candidates.push(`${pendingPrefix} ${combo}`);
  candidates.push(combo);

  const ordered = [...bindings].sort((a, b) => b.scope - a.scope || b.id - a.id);
  for (const cand of candidates) {
    for (const b of ordered) {
      if (!b.enabled.current) continue;
      if (overlayDepth > 0 && b.scope < SCOPE.overlay) continue;
      if (typing && !b.allowInInput) continue;
      if (!b.keys.includes(cand)) continue;
      const r = b.handler.current(e);
      if (r === false) continue; // ハンドラが「処理しない」と返したら次へ
      e.preventDefault();
      e.stopPropagation();
      clearPrefix();
      return;
    }
  }
  // シーケンスの 1 打鍵目か？
  if (!typing && !combo.includes("+") && overlayDepth === 0) {
    const isPrefix = bindings.some((b) => b.enabled.current && b.keys.some((k) => k.startsWith(`${combo} `)));
    if (isPrefix) {
      pendingPrefix = combo;
      if (prefixTimer) clearTimeout(prefixTimer);
      prefixTimer = setTimeout(clearPrefix, 1200);
      return;
    }
  }
  clearPrefix();
}

function clearPrefix() {
  pendingPrefix = null;
  if (prefixTimer) clearTimeout(prefixTimer);
  prefixTimer = null;
}

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", onKeyDown);
}

export const SCOPE = { global: 0, view: 10, detail: 20, overlay: 100 } as const;

/** モーダル・ポップオーバーが表示されている間、下の画面のショートカットを無効にする */
export function useOverlayLock(active = true) {
  useEffect(() => {
    if (!active) return;
    overlayDepth++;
    return () => {
      overlayDepth = Math.max(0, overlayDepth - 1);
    };
  }, [active]);
}

export function useHotkeys(
  keys: string | string[],
  handler: Handler,
  opts: { enabled?: boolean; allowInInput?: boolean; scope?: number } = {},
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabledRef = useRef(opts.enabled ?? true);
  enabledRef.current = opts.enabled ?? true;
  const keyStr = Array.isArray(keys) ? keys.join("|") : keys;
  useEffect(() => {
    install();
    const b: Binding = {
      id: nextId++,
      keys: keyStr.split("|").map((k) => k.split(" ").map(normalizeCombo).join(" ")),
      handler: handlerRef,
      allowInInput: !!opts.allowInInput,
      enabled: enabledRef,
      scope: opts.scope ?? SCOPE.global,
    };
    bindings.push(b);
    return () => {
      const i = bindings.indexOf(b);
      if (i >= 0) bindings.splice(i, 1);
    };
  }, [keyStr, opts.allowInInput, opts.scope]);
}

/** 表示用: "mod+k" → ["⌘", "K"] */
export function comboLabel(combo: string): string[] {
  return combo.split(" ").flatMap((part, i, arr) => {
    const keys = part.split("+").map((k) => {
      switch (k) {
        case "mod":
          return isMac ? "⌘" : "Ctrl";
        case "shift":
          return "⇧";
        case "alt":
          return isMac ? "⌥" : "Alt";
        case "ctrl":
          return "Ctrl";
        case "enter":
          return "Enter";
        case "escape":
          return "Esc";
        case "backspace":
          return "⌫";
        case "delete":
          return "Del";
        case "arrowup":
          return "↑";
        case "arrowdown":
          return "↓";
        case "space":
          return "Space";
        default:
          return k.length === 1 ? k.toUpperCase() : k;
      }
    });
    return i < arr.length - 1 ? [...keys, "→"] : keys;
  });
}
