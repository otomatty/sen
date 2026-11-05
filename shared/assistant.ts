// AI アシスタントのリクエストと、NDJSON で返すイベント。画面と Worker で共有する。

import type { ScreenId } from "./navigation";

export type AssistantAction =
  | { kind: "open_screen"; screen: ScreenId }
  | { kind: "play_tutorial"; tutorial: string; chapter: number } // chapter は 1 から
  | { kind: "ask_user"; question: string; options: string[] };

export interface AssistantHistoryMessage {
  role: "user" | "assistant";
  text: string;
  actions?: AssistantAction[];
}

export interface AssistantRequest {
  messages: AssistantHistoryMessage[];
  screen?: string | null; // いま開いている画面の ScreenId（無ければ null）
}

// 応答は NDJSON（1 行に 1 つの JSON）。Content-Type: application/x-ndjson; charset=utf-8
export type AssistantEvent =
  | { type: "text"; text: string } // 本文の続き
  | { type: "action"; action: AssistantAction }
  | { type: "done"; remaining: number }
  | { type: "error"; message: string };

export const ASSISTANT_MAX_QUESTION = 1000; // 質問の最大文字数
export const ASSISTANT_MAX_HISTORY = 20; // 送る会話の最大件数
