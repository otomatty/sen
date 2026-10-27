import type { Issue, Team } from "../../shared/types";

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 非セキュアコンテキスト向けのフォールバック
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function identifier(issue: Pick<Issue, "number" | "teamId">, teams: Record<string, Team>): string {
  const t = teams[issue.teamId];
  return `${t?.key ?? "?"}-${issue.number}`;
}

export function initials(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  // 日本語などは先頭1文字、英語は頭文字2つ
  if (/^[\x00-\x7F]/.test(n)) {
    const parts = n.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return n[0];
}

const rtf = new Intl.RelativeTimeFormat("ja", { numeric: "auto" });

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.round((ts - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return "たった今";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(ts);
}

export function shortTimeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "今";
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}日`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}か月`;
  return `${Math.floor(s / 86400 / 365)}年`;
}

export function formatDate(ts: number | string, withYear?: boolean): string {
  const d = typeof ts === "string" ? new Date(`${ts}T00:00:00`) : new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("ja-JP", {
    year: withYear || !sameYear ? "numeric" : undefined,
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function localYmd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dueStatus(due: string | null): "overdue" | "soon" | "normal" | null {
  if (!due) return null;
  const today = localYmd();
  if (due < today) return "overdue";
  const d = new Date(`${due}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime();
  if (d <= 2 * 86400000) return "soon";
  return "normal";
}

export function htmlToText(html: string): string {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html.replace(/<\/(p|li|h\d)>/g, "$& ");
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function isHtmlEmpty(html: string): boolean {
  return !htmlToText(html) && !/<img|<hr/i.test(html);
}

/** 平仮名⇔片仮名・全角⇔半角・大文字小文字の違いを吸収した検索用の正規化 */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = normalizeSearch(text);
  return normalizeSearch(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => t.includes(q));
}

export function pluralCount(n: number, unit = "件"): string {
  return `${n}${unit}`;
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text);
  return Promise.resolve();
}

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    // noop
  }
  ta.remove();
}

/** 共有用の絶対 URL（デモ版はハッシュルーティング） */
export function appUrl(path: string): string {
  if (typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) return `${location.href.split("#")[0]}#${path}`;
  return `${location.origin}${path}`;
}

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても動作は続ける
  }
}
