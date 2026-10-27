import type { ProjectStatus, StateType } from "./types";

export const PRIORITIES = [
  { value: 0, label: "優先度なし", short: "なし" },
  { value: 1, label: "緊急", short: "緊急" },
  { value: 2, label: "高", short: "高" },
  { value: 3, label: "中", short: "中" },
  { value: 4, label: "低", short: "低" },
] as const;

// ピッカーや並び替えで使う表示順（緊急 → 低 → なし）
export const PRIORITY_ORDER = [1, 2, 3, 4, 0];

export function priorityLabel(p: number): string {
  return PRIORITIES.find((x) => x.value === p)?.label ?? "優先度なし";
}

export const STATE_TYPES: { type: StateType; label: string }[] = [
  { type: "backlog", label: "バックログ" },
  { type: "unstarted", label: "未着手" },
  { type: "started", label: "進行中" },
  { type: "completed", label: "完了" },
  { type: "canceled", label: "キャンセル" },
];

export const STATE_TYPE_ORDER: Record<StateType, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 4,
};

export const DEFAULT_STATES: { name: string; type: StateType; color: string }[] = [
  { name: "バックログ", type: "backlog", color: "#8b8d93" },
  { name: "未着手", type: "unstarted", color: "#b7b9be" },
  { name: "進行中", type: "started", color: "#f0bf37" },
  { name: "レビュー中", type: "started", color: "#3fb27f" },
  { name: "完了", type: "completed", color: "#6470e8" },
  { name: "キャンセル", type: "canceled", color: "#8b8d93" },
  { name: "重複", type: "canceled", color: "#8b8d93" },
];

export const PROJECT_STATUSES: { value: ProjectStatus; label: string; color: string }[] = [
  { value: "backlog", label: "バックログ", color: "#8b8d93" },
  { value: "planned", label: "計画中", color: "#b7b9be" },
  { value: "started", label: "進行中", color: "#f0bf37" },
  { value: "paused", label: "一時停止", color: "#e98a3b" },
  { value: "completed", label: "完了", color: "#6470e8" },
  { value: "canceled", label: "キャンセル", color: "#8b8d93" },
];

export function projectStatusLabel(s: ProjectStatus): string {
  return PROJECT_STATUSES.find((x) => x.value === s)?.label ?? s;
}

export const PALETTE = [
  "#6470e8",
  "#4ea7fc",
  "#26b5ce",
  "#3fb27f",
  "#90c440",
  "#f0bf37",
  "#e98a3b",
  "#eb5757",
  "#e255a1",
  "#a76be8",
  "#8b8d93",
  "#5c6b7a",
];

export const AVATAR_COLORS = [
  "#6470e8",
  "#4ea7fc",
  "#26b5ce",
  "#3fb27f",
  "#e98a3b",
  "#eb5757",
  "#e255a1",
  "#a76be8",
  "#c4932f",
  "#5c8a6e",
];

export const ESTIMATES = [0, 1, 2, 3, 5, 8];

export const NOTIFICATION_LABELS: Record<string, string> = {
  assigned: "があなたに割り当てました",
  comment: "がコメントしました",
  mention: "があなたをメンションしました",
  state: "がステータスを変更しました",
  created: "が課題を作成しました",
};
