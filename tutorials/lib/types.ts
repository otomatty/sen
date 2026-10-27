import type { Director } from "./director";

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

export interface Scenario {
  id: string;
  order: number;
  screen: ScreenKey;
  title: string;
  summary: string;
  /** 収録を始める前に開いておく画面（ワークスペースからの相対パス） */
  start: string;
  /** 新規ユーザーとして始める（ようこそ画面を表示する） */
  freshUser?: boolean;
  run(t: Director): Promise<void>;
}

export function defineScenario(s: Scenario): Scenario {
  return s;
}
