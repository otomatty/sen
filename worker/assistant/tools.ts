// ツールの検証と結果。画面側とは往復せず、Worker の中で決める。
// 履歴に入っていた操作も、同じ規則に合わないものは捨てる（クライアントの値は信用しない）。

import type { AssistantAction } from "../../shared/assistant";
import { isScreenId, type ScreenId } from "../../shared/navigation";
import { findTutorial, screenTitle } from "./prompt";

export const LIMITS = { open_screen: 3, play_tutorial: 2, ask_user: 1 } as const;

export interface ToolBudget {
  counts: { open_screen: number; play_tutorial: number; ask_user: number };
  seen: Set<string>;
}

export function newToolBudget(): ToolBudget {
  return { counts: { open_screen: 0, play_tutorial: 0, ask_user: 0 }, seen: new Set() };
}

export interface ToolEffect {
  content: string;
  isError: boolean;
  action?: AssistantAction;
  /** ask_user を表示できたら、その応答はここで終える */
  endTurn: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function screenError(screen: unknown): string | null {
  if (!isScreenId(screen)) return "画面の指定が正しくありません";
  return null;
}

function tutorialError(tutorial: unknown, chapter: unknown): string | null {
  if (typeof tutorial !== "string") return "動画の指定が正しくありません";
  const found = findTutorial(tutorial);
  if (!found) return "動画の指定が正しくありません";
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 1 || chapter > found.steps) {
    return `ステップは 1〜${found.steps} です`;
  }
  return null;
}

function askError(question: unknown, options: unknown): string | null {
  if (typeof question !== "string") return "質問の形が正しくありません";
  if (question.length > 200) return "質問は200文字以内にしてください";
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return "選択肢は2〜4個にしてください";
  if (!options.every((option) => typeof option === "string" && option.length <= 40)) return "選択肢は40文字以内にしてください";
  return null;
}

function actionKey(action: AssistantAction): string {
  return JSON.stringify(action);
}

/** 履歴の actions。合わなければ null（その要素だけ捨てる） */
export function parseHistoryAction(raw: unknown): AssistantAction | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.kind === "open_screen") {
    if (screenError(rec.screen)) return null;
    return { kind: "open_screen", screen: rec.screen as ScreenId };
  }
  if (rec.kind === "play_tutorial") {
    if (tutorialError(rec.tutorial, rec.chapter)) return null;
    return { kind: "play_tutorial", tutorial: rec.tutorial as string, chapter: rec.chapter as number };
  }
  if (rec.kind === "ask_user") {
    if (askError(rec.question, rec.options)) return null;
    return { kind: "ask_user", question: rec.question as string, options: [...(rec.options as string[])] };
  }
  return null;
}

function accept(action: AssistantAction, budget: ToolBudget): ToolEffect {
  const key = actionKey(action);
  if (budget.seen.has(key)) {
    const content =
      action.kind === "ask_user"
        ? "すでに質問と選択肢を表示しています。利用者の回答を待つため、ここで応答を終えてください。"
        : "すでに表示しています。";
    return { content, isError: false, endTurn: action.kind === "ask_user" };
  }
  if (budget.counts[action.kind] >= LIMITS[action.kind]) {
    return { content: "これ以上は表示できません", isError: true, endTurn: false };
  }
  budget.seen.add(key);
  budget.counts[action.kind] += 1;
  if (action.kind === "open_screen") {
    return {
      content: `「${screenTitle(action.screen)}」を開くボタンを表示しました。利用者が押すと開きます。`,
      isError: false,
      action,
      endTurn: false,
    };
  }
  if (action.kind === "play_tutorial") {
    const title = findTutorial(action.tutorial)?.title ?? "";
    return {
      content: `使い方動画「${title}」のステップ ${action.chapter} を表示しました。`,
      isError: false,
      action,
      endTurn: false,
    };
  }
  return {
    content: "質問と選択肢を表示しました。利用者の回答を待つため、ここで応答を終えてください。",
    isError: false,
    action,
    endTurn: true,
  };
}

export function executeTool(name: string, input: unknown, budget: ToolBudget): ToolEffect {
  const rec = asRecord(input);
  if (name === "open_screen") {
    const error = screenError(rec?.screen);
    if (error || !rec || !isScreenId(rec.screen)) return { content: error ?? "画面の指定が正しくありません", isError: true, endTurn: false };
    return accept({ kind: "open_screen", screen: rec.screen }, budget);
  }
  if (name === "play_tutorial") {
    const error = tutorialError(rec?.tutorial, rec?.chapter);
    if (error || !rec || typeof rec.tutorial !== "string" || typeof rec.chapter !== "number") {
      return { content: error ?? "動画の指定が正しくありません", isError: true, endTurn: false };
    }
    return accept({ kind: "play_tutorial", tutorial: rec.tutorial, chapter: rec.chapter }, budget);
  }
  if (name === "ask_user") {
    const error = askError(rec?.question, rec?.options);
    if (error || !rec || typeof rec.question !== "string" || !Array.isArray(rec.options)) {
      return { content: error ?? "質問の形が正しくありません", isError: true, endTurn: false };
    }
    return accept({ kind: "ask_user", question: rec.question, options: [...(rec.options as string[])] }, budget);
  }
  return { content: "この操作はできません", isError: true, endTurn: false };
}
