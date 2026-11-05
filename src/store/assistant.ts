// AI アシスタントのパネル。会話はメモリだけ（再読み込みで消える）。ワークスペースのデータは送らない。

import { create } from "zustand";
import {
  ASSISTANT_MAX_HISTORY,
  ASSISTANT_MAX_QUESTION,
  type AssistantAction,
  type AssistantEvent,
  type AssistantHistoryMessage,
} from "../../shared/assistant";
import { isScreenId, screenForPath } from "../../shared/navigation";
import { ApiError, api, apiStream } from "../lib/api";

export interface AssistantStatus {
  enabled: boolean;
  limit: number;
  remaining: number;
}

export interface AssistantChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions: AssistantAction[];
  error?: string;
  /** 聞き返しの選択肢を押したあと */
  answered?: boolean;
  /** 応答を受け取り終えるまで */
  pending?: boolean;
}

interface AssistantState {
  open: boolean;
  messages: AssistantChatMessage[];
  sending: boolean;
  status: AssistantStatus | null;
}

export const useAssistant = create<AssistantState>(() => ({
  open: false,
  messages: [],
  sending: false,
  status: null,
}));

let generation = 0;
let controller: AbortController | null = null;
let workspaceKey: string | null = null;
let statusSeq = 0;
/** 最後に status の取得を始めた時刻。画面に戻ったときの再取得を間引く */
let statusFetchedAt = 0;

function nextId(): string {
  return crypto.randomUUID();
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

function isStatus(v: unknown): v is AssistantStatus {
  if (!v || typeof v !== "object") return false;
  const s = v as AssistantStatus;
  return typeof s.enabled === "boolean" && typeof s.limit === "number" && typeof s.remaining === "number";
}

function readAction(value: unknown): AssistantAction | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "open_screen" && isScreenId(raw.screen)) return { kind: "open_screen", screen: raw.screen };
  if (raw.kind === "play_tutorial" && typeof raw.tutorial === "string" && Number.isInteger(raw.chapter) && (raw.chapter as number) >= 1) {
    return { kind: "play_tutorial", tutorial: raw.tutorial, chapter: raw.chapter as number };
  }
  if (
    raw.kind === "ask_user" &&
    typeof raw.question === "string" &&
    Array.isArray(raw.options) &&
    raw.options.every((option) => typeof option === "string")
  ) {
    return { kind: "ask_user", question: raw.question, options: raw.options.slice() };
  }
  return null;
}

function readEvent(value: unknown): AssistantEvent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "text" && typeof raw.text === "string") return { type: "text", text: raw.text };
  if (raw.type === "action") {
    const action = readAction(raw.action);
    return action ? { type: "action", action } : null;
  }
  if (raw.type === "done" && typeof raw.remaining === "number" && Number.isFinite(raw.remaining)) {
    return { type: "done", remaining: raw.remaining };
  }
  if (raw.type === "error" && typeof raw.message === "string") return { type: "error", message: raw.message };
  return null;
}

/** エラーだけの応答と、送信中の応答は送らない */
function historyPayload(messages: AssistantChatMessage[], question: string): AssistantHistoryMessage[] {
  const items: AssistantHistoryMessage[] = [];
  for (const message of messages) {
    if (message.pending) continue;
    if (message.role === "assistant" && !message.text.trim() && message.error) continue;
    if (message.role === "assistant" && message.actions.length) items.push({ role: message.role, text: message.text, actions: message.actions });
    else items.push({ role: message.role, text: message.text });
  }
  items.push({ role: "user", text: question });
  return items.slice(-ASSISTANT_MAX_HISTORY);
}

function applyEvent(id: string, event: AssistantEvent) {
  if (event.type === "text") {
    useAssistant.setState((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, text: m.text + event.text } : m)),
    }));
    return;
  }
  if (event.type === "action") {
    useAssistant.setState((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, actions: [...m.actions, event.action] } : m)),
    }));
    return;
  }
  if (event.type === "done") {
    // 応答で残りが確定した。それより前に始めた status の取得では上書きしない
    statusSeq += 1;
    useAssistant.setState((s) => ({
      status: {
        enabled: s.status?.enabled ?? true,
        limit: s.status?.limit ?? 0,
        remaining: event.remaining,
      },
    }));
    return;
  }
  useAssistant.setState((s) => ({
    messages: s.messages.map((m) => (m.id === id ? { ...m, error: event.message } : m)),
  }));
}

function finish(id: string, myGen: number, opts?: { error?: string; quota?: boolean }) {
  if (myGen !== generation) return;
  // 429 で残りを 0 にしたあと、古い status の応答で戻さない
  if (opts?.quota) statusSeq += 1;
  useAssistant.setState((s) => ({
    sending: false,
    status: opts?.quota
      ? s.status
        ? { ...s.status, remaining: 0 }
        : { enabled: true, limit: 0, remaining: 0 }
      : s.status,
    messages: s.messages.map((m) => {
      if (m.id !== id) return m;
      return { ...m, pending: false, ...(opts?.error ? { error: opts.error } : {}) };
    }),
  }));
}

async function readNdjson(body: ReadableStream<Uint8Array>, onEvent: (event: AssistantEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = readEvent(JSON.parse(trimmed) as unknown);
      if (event) onEvent(event);
    } catch {
      // 壊れた行は飛ばす。途中で切れた行は buffer に残している
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        take(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) take(buffer.replace(/\r$/, ""));
  } finally {
    reader.releaseLock();
  }
}

function pageContext(): { ws: string; screen: string | null } | null {
  if (typeof window === "undefined") return null;
  const pathname = window.location.pathname;
  const ws = pathname.split("/").filter(Boolean)[0];
  if (!ws) return null;
  return { ws, screen: screenForPath(pathname) };
}

/** ワークスペースを開いたとき。失敗したら使えない扱いにする。別のワークスペースなら会話を消す */
export async function loadAssistantStatus(ws: string) {
  const seq = ++statusSeq;
  statusFetchedAt = Date.now();
  if (workspaceKey !== ws) {
    workspaceKey = ws;
    generation += 1;
    controller?.abort();
    controller = null;
    useAssistant.setState({ open: false, messages: [], sending: false, status: null });
  }
  try {
    const status = await api<unknown>(`/api/assistant/status?ws=${encodeURIComponent(ws)}`);
    if (seq !== statusSeq || workspaceKey !== ws) return;
    if (!isStatus(status)) throw new Error("status");
    useAssistant.setState({ status });
  } catch (e) {
    if (isAbortError(e)) return;
    if (seq !== statusSeq || workspaceKey !== ws) return;
    useAssistant.setState({ status: { enabled: false, limit: 0, remaining: 0 } });
  }
}

/**
 * 会話を消さずに、いまのワークスペースの status だけを取り直す。
 * minIntervalMs より新しい取得があるときは何もしない。
 * 失敗しても、すでに持っている status は上書きしない。まだ持っていないときだけ使えない扱いにする。
 */
export async function refreshAssistantStatus(opts?: { minIntervalMs?: number }) {
  const ws = workspaceKey;
  if (!ws) return;
  if (opts?.minIntervalMs != null && Date.now() - statusFetchedAt < opts.minIntervalMs) return;
  const seq = ++statusSeq;
  statusFetchedAt = Date.now();
  try {
    const status = await api<unknown>(`/api/assistant/status?ws=${encodeURIComponent(ws)}`);
    if (seq !== statusSeq || workspaceKey !== ws) return;
    if (!isStatus(status)) throw new Error("status");
    useAssistant.setState({ status });
  } catch (e) {
    if (isAbortError(e)) return;
    if (seq !== statusSeq || workspaceKey !== ws) return;
    if (useAssistant.getState().status) return;
    useAssistant.setState({ status: { enabled: false, limit: 0, remaining: 0 } });
  }
}

export function openAssistant(question?: string) {
  useAssistant.setState({ open: true });
  void refreshAssistantStatus();
  const text = question?.trim() ?? "";
  if (!text) return;
  const ctx = pageContext();
  if (!ctx) return;
  void sendAssistantQuestion(ctx.ws, text, ctx.screen);
}

export function closeAssistant() {
  useAssistant.setState({ open: false });
}

export function stopAssistant() {
  controller?.abort();
}

export function resetAssistant() {
  // generation を進めると、送信中の catch は何もせずに戻る。中止したときだけ残りを取り直す
  const inflight = controller != null;
  generation += 1;
  controller?.abort();
  controller = null;
  useAssistant.setState({ messages: [], sending: false });
  if (inflight) void refreshAssistantStatus();
}

export async function sendAssistantQuestion(ws: string, text: string, screen: string | null) {
  const trimmed = text.trim();
  if (!trimmed || useAssistant.getState().sending) return;

  const userId = nextId();
  const assistantId = nextId();
  const userMessage: AssistantChatMessage = { id: userId, role: "user", text: trimmed, actions: [] };
  if (trimmed.length > ASSISTANT_MAX_QUESTION) {
    useAssistant.setState((s) => ({
      open: true,
      messages: [
        ...s.messages,
        userMessage,
        {
          id: assistantId,
          role: "assistant",
          text: "",
          actions: [],
          error: `質問は${ASSISTANT_MAX_QUESTION}文字以内で入力してください`,
        },
      ],
    }));
    return;
  }

  const payload = historyPayload(useAssistant.getState().messages, trimmed);
  const myGen = ++generation;
  const mine = new AbortController();
  controller = mine;
  useAssistant.setState((s) => ({
    open: true,
    sending: true,
    messages: [...s.messages, userMessage, { id: assistantId, role: "assistant", text: "", actions: [], pending: true }],
  }));

  try {
    const res = await apiStream(
      `/api/assistant?ws=${encodeURIComponent(ws)}`,
      { messages: payload, screen: isScreenId(screen) ? screen : null },
      mine.signal,
    );
    if (myGen !== generation) return;
    if (!res.body) throw new ApiError("応答を読み取れませんでした", 0);
    let sawDone = false;
    await readNdjson(res.body, (event) => {
      if (myGen !== generation) return;
      if (event.type === "done") sawDone = true;
      applyEvent(assistantId, event);
    });
    if (myGen !== generation) return;
    // 停止はエラーにしない。done の前に切れた応答は成功にせず、消費された残りを取り直す
    if (mine.signal.aborted) {
      finish(assistantId, myGen);
      void refreshAssistantStatus();
      return;
    }
    if (!sawDone) {
      finish(assistantId, myGen, { error: "応答が途中で終了しました。もう一度お試しください。" });
      void refreshAssistantStatus();
      return;
    }
    finish(assistantId, myGen);
  } catch (e) {
    if (myGen !== generation) return;
    if (isAbortError(e) || mine.signal.aborted) {
      finish(assistantId, myGen);
      void refreshAssistantStatus();
      return;
    }
    const message = e instanceof ApiError ? e.message : "ネットワークに接続できません";
    finish(assistantId, myGen, { error: message, quota: e instanceof ApiError && e.status === 429 });
  } finally {
    if (controller === mine) controller = null;
  }
}
