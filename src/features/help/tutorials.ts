import { useEffect, useState } from "react";

// 操作説明動画のメタデータ。動画本体と manifest.json は `npm run tutorials` が自動生成する。

export interface TutorialChapter {
  t: number; // 秒
  title: string;
}

export interface Tutorial {
  id: string;
  title: string;
  summary: string;
  screen: ScreenKey;
  order: number;
  duration: number;
  video: string;
  poster: string;
  chapters: TutorialChapter[];
  recordedAt?: string;
}

export type ScreenKey =
  | "overview"
  | "issues"
  | "board"
  | "issue"
  | "create"
  | "palette"
  | "inbox"
  | "my-issues"
  | "projects"
  | "cycles"
  | "search"
  | "settings";

export const SCREENS: Record<ScreenKey, string> = {
  overview: "全体像",
  issues: "課題一覧",
  board: "ボード",
  issue: "課題の詳細",
  create: "課題の作成",
  palette: "コマンドパレット",
  inbox: "受信トレイ",
  "my-issues": "自分の課題",
  projects: "プロジェクト",
  cycles: "サイクル",
  search: "検索",
  settings: "設定",
};

let cache: Tutorial[] | null = null;
let loading: Promise<Tutorial[]> | null = null;

export function tutorialAsset(path: string): string {
  // デモ版（単一 HTML）では相対パスで参照する
  if (typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) return path.replace(/^\//, "");
  return path;
}

function load(): Promise<Tutorial[]> {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = fetch(tutorialAsset("/tutorials/manifest.json"), { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tutorials: Tutorial[] }>) : { tutorials: [] as Tutorial[] }))
      .then((d: { tutorials: Tutorial[] }) => {
        cache = (d.tutorials ?? []).sort((a, b) => a.order - b.order);
        return cache;
      })
      .catch(() => {
        cache = [];
        return cache;
      });
  }
  return loading;
}

export function useTutorials(): Tutorial[] | null {
  const [list, setList] = useState<Tutorial[] | null>(cache);
  useEffect(() => {
    if (!cache) load().then(setList);
  }, []);
  return list;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
