// クライアントから来た会話を、Claude に渡す形へ整える。ワークスペースのデータは受け取らない。

import {
  ASSISTANT_MAX_HISTORY,
  ASSISTANT_MAX_QUESTION,
  type AssistantAction,
} from "../../shared/assistant";
import { isScreenId, type ScreenId } from "../../shared/navigation";
import { historyText, screenTitle } from "./prompt";
import { LIMITS, parseHistoryAction } from "./tools";

const FORMAT_ERROR = "形式が正しくありません";
const EMPTY_QUESTION = "質問を入力してください";
const TOO_LONG = "質問は1000文字以内で入力してください";
/** 1 回の応答で出せる操作の合計。履歴の assistant メッセージも同じ数まで */
const MAX_HISTORY_ACTIONS = Object.values(LIMITS).reduce((sum, count) => sum + count, 0);

/** 検証に通った操作だけを数え、上限に達したらそこで止める。先に配列は切らない */
function takeHistoryActions(raw: unknown): AssistantAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: AssistantAction[] = [];
  for (const item of raw) {
    const parsed = parseHistoryAction(item);
    if (!parsed) continue;
    actions.push(parsed);
    if (actions.length >= MAX_HISTORY_ACTIONS) break;
  }
  return actions;
}

export interface NormalizedMessage {
  role: "user" | "assistant";
  text: string;
  actions: AssistantAction[];
}

export interface ModelTextBlock {
  type: "text";
  text: string;
}

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ModelTextBlock[];
}

export type ParsedRequest = { messages: NormalizedMessage[]; screen: ScreenId | null };

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** 入力を確かめる。ここまでは普通の JSON のエラーにする */
export function parseAssistantRequest(body: unknown): { ok: true; value: ParsedRequest } | { ok: false; error: string } {
  const rec = asRecord(body);
  if (!rec || !Array.isArray(rec.messages)) return { ok: false, error: FORMAT_ERROR };

  let items = rec.messages.slice(-ASSISTANT_MAX_HISTORY);
  while (items.length > 0 && asRecord(items[0])?.role === "assistant") items = items.slice(1);
  if (items.length === 0) return { ok: false, error: EMPTY_QUESTION };

  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = asRecord(items[i]);
    if (!raw || (raw.role !== "user" && raw.role !== "assistant") || typeof raw.text !== "string") {
      return { ok: false, error: FORMAT_ERROR };
    }
    const text = raw.text.trim();
    const last = i === items.length - 1;
    if (last && raw.role !== "user") return { ok: false, error: EMPTY_QUESTION };
    if (last && !text) return { ok: false, error: EMPTY_QUESTION };
    if (last && text.length > ASSISTANT_MAX_QUESTION) return { ok: false, error: TOO_LONG };
    const clipped =
      raw.role === "assistant" ? text.slice(0, 4000) : last ? text : text.slice(0, ASSISTANT_MAX_QUESTION);
    const actions = raw.role === "assistant" ? takeHistoryActions(raw.actions) : [];
    messages.push({ role: raw.role, text: clipped, actions });
  }

  return { ok: true, value: { messages, screen: isScreenId(rec.screen) ? rec.screen : null } };
}

/**
 * クライアントから来た文字だけで会話を作り直す。
 * 空の発話を飛ばすと役割が続くので、同じ役割は 1 つにまとめる。先頭の assistant は残さない。
 */
export function toModelMessages(messages: NormalizedMessage[], screen: ScreenId | null): ModelMessage[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of messages) {
    const text = message.role === "assistant" ? historyText(message.text, message.actions) : message.text;
    if (!text) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === message.role) prev.text = `${prev.text}\n\n${text}`;
    else turns.push({ role: message.role, text });
  }
  while (turns[0]?.role === "assistant") turns.shift();

  return turns.map((turn, index) => {
    const last = index === turns.length - 1;
    if (turn.role === "user" && last && screen) {
      return {
        role: "user",
        content: [
          { type: "text", text: `（いま開いている画面：${screenTitle(screen)}）` },
          { type: "text", text: turn.text },
        ],
      };
    }
    return { role: turn.role, content: turn.text };
  });
}
