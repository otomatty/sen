import { create } from "zustand";
import { readLocal, writeLocal } from "../lib/utils";

export interface Toast {
  id: number;
  message: string;
  kind?: "info" | "error" | "success";
  action?: { label: string; run: () => void };
  duration?: number;
}

export type PickerKind =
  | "status"
  | "priority"
  | "assignee"
  | "labels"
  | "project"
  | "cycle"
  | "estimate"
  | "dueDate"
  | "team"
  | "parent"
  | "relation";

export interface PickerRequest {
  kind: PickerKind;
  issueIds: string[];
  /** 指定するとその要素の近くに出る。無ければ画面中央（キーボード操作時） */
  anchor?: DOMRect | null;
  /** kind が relation のとき、追加する関係の向き */
  relation?: "blocks" | "blockedBy" | "related" | "duplicate" | "duplicatedBy";
}

export interface CreateIssueDefaults {
  teamId?: string;
  stateId?: string;
  priority?: number;
  assigneeId?: string | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  labelIds?: string[];
}

export type Theme = "system" | "light" | "dark";

interface UIState {
  toasts: Toast[];
  paletteOpen: boolean;
  palettePage: string | null;
  createOpen: boolean;
  createDefaults: CreateIssueDefaults;
  projectCreateOpen: boolean;
  shortcutsOpen: boolean;
  picker: PickerRequest | null;
  videoId: string | null;
  focusedIssueId: string | null;
  selectedIssueIds: string[];
  listIds: string[];
  listLabel: string;
  listPath: string;
  sidebarOpen: boolean;
  theme: Theme;
  contextMenu: { x: number; y: number; issueIds: string[] } | null;
  welcomeOpen: boolean;
}

export const useUI = create<UIState>(() => ({
  toasts: [],
  paletteOpen: false,
  palettePage: null,
  createOpen: false,
  createDefaults: {},
  projectCreateOpen: false,
  shortcutsOpen: false,
  picker: null,
  videoId: null,
  focusedIssueId: null,
  selectedIssueIds: [],
  listIds: [],
  listLabel: "",
  listPath: "",
  sidebarOpen: false,
  theme: readLocal<Theme>("sen:theme-v", "system"),
  contextMenu: null,
  welcomeOpen: false,
}));

let toastId = 1;
export function toast(message: string, opts: Omit<Toast, "id" | "message"> = {}) {
  const id = toastId++;
  useUI.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, ...opts }] }));
  const duration = opts.duration ?? (opts.action ? 6000 : 3500);
  // Infinity は閉じるまで出し続ける
  if (Number.isFinite(duration)) setTimeout(() => dismissToast(id), duration);
  return id;
}
export function dismissToast(id: number) {
  useUI.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openCreateIssue(defaults: CreateIssueDefaults = {}) {
  useUI.setState({ createOpen: true, createDefaults: defaults, paletteOpen: false, picker: null });
}

export function openPicker(req: PickerRequest) {
  if (!req.issueIds.length) return;
  useUI.setState({ picker: req, paletteOpen: false, contextMenu: null });
}

export function openPalette(page: string | null = null) {
  useUI.setState({ paletteOpen: true, palettePage: page, picker: null, contextMenu: null });
}

export function closeOverlays() {
  useUI.setState({ paletteOpen: false, picker: null, contextMenu: null, shortcutsOpen: false });
}

/** ショートカットの対象: 選択中 → フォーカス中 の順 */
export function targetIssueIds(): string[] {
  const s = useUI.getState();
  if (s.selectedIssueIds.length) return s.selectedIssueIds;
  return s.focusedIssueId ? [s.focusedIssueId] : [];
}

export function setTheme(theme: Theme) {
  writeLocal("sen:theme-v", theme);
  try {
    localStorage.setItem("sen:theme", theme);
  } catch {
    // noop
  }
  useUI.setState({ theme });
  applyTheme(theme);
}

export function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // インストールしたアプリのタイトルバーやスマートフォンのステータスバーを、画面の背景色にそろえる
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

if (typeof window !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (useUI.getState().theme === "system") applyTheme("system");
  });
}
