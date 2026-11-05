// Claude への送信。ワークスペースのデータ（課題・プロジェクト・メンバー・チーム名など）は渡さない。
// 送るのは使い方の知識、利用者の質問と会話、いま開いている画面の種類だけ。

import Anthropic from "@anthropic-ai/sdk";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { AssistantEvent } from "../../shared/assistant";
import type { AppEnv } from "../env";
import type { AssistantConfig } from "./config";
import { ASSISTANT_TOOLS, SYSTEM_TEXT } from "./prompt";
import type { ModelMessage } from "./request";
import { executeTool, newToolBudget, type ToolEffect } from "./tools";
import { refundQuota, type QuotaResult } from "./usage";

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 4096;
const MAX_TURNS = 4;

const BUSY = "AI が混み合っています（または接続できません）。少し待ってからもう一度お試しください。";
const CONFIG_ERROR = "AI アシスタントの設定に問題があります。";
const GENERIC = "エラーが発生しました。もう一度お試しください。";
const REFUSAL = "この質問にはお答えできません。";

function isAbortError(e: unknown): boolean {
  return e instanceof Anthropic.APIUserAbortError || (e instanceof Error && e.name === "AbortError");
}

/** 例外の種類で分ける。メッセージの文字列では判定しない。キーや本文はログに出さない */
function publicError(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError) return BUSY;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    console.error("AI アシスタントの設定に問題があります", e.name, e.status, e.type ?? "");
    return CONFIG_ERROR;
  }
  if (e instanceof Anthropic.APIError && typeof e.status === "number" && (e.status === 529 || e.status >= 500)) return BUSY;
  const name = e instanceof Anthropic.APIError ? `${e.name} ${e.status} ${e.type ?? ""}` : e instanceof Error ? e.name : "unknown";
  console.error("assistant error", name.trim());
  return GENERIC;
}

function logUsage(usage: Anthropic.Message["usage"]): void {
  console.log("assistant usage", {
    input_tokens: usage.input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: usage.output_tokens,
  });
}

function isToolUse(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

export function streamAssistant(
  c: Context<AppEnv>,
  cfg: AssistantConfig,
  modelMessages: ModelMessage[],
  quota: QuotaResult,
): Response {
  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  return stream(c, async (out) => {
    const ac = new AbortController();
    let aborted = false;
    const stop = () => {
      aborted = true;
      ac.abort();
    };
    out.onAbort(stop);
    if (c.req.raw.signal.aborted) stop();
    else c.req.raw.signal.addEventListener("abort", stop, { once: true });

    let delivered = false;
    let sentText = false;
    let remaining = quota.remaining;
    const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });
    const messages: Anthropic.MessageParam[] = modelMessages;

    const emit = async (event: AssistantEvent) => {
      if (aborted) return;
      if (event.type === "text" || event.type === "action") delivered = true;
      await out.writeln(JSON.stringify(event));
    };

    const finish = async (errorMessage: string | null) => {
      if (aborted) return;
      if (errorMessage && !delivered) {
        try {
          await refundQuota(c.env.DB, c.get("user").id, quota.day);
          remaining = Math.min(cfg.dailyLimit, remaining + 1);
        } catch (e) {
          console.error("assistant refund", e instanceof Error ? e.name : "unknown");
        }
      }
      if (aborted) return;
      if (errorMessage) await emit({ type: "error", message: errorMessage });
      if (aborted) return;
      await emit({ type: "done", remaining });
    };

    const complete = async (): Promise<Anthropic.Message> => {
      let wroteThisRound = false;
      let chain = Promise.resolve();
      const response = client.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          output_config: { effort: "low" },
          system: [{ type: "text", text: SYSTEM_TEXT, cache_control: { type: "ephemeral" } }],
          tools: ASSISTANT_TOOLS,
          messages,
        },
        { signal: ac.signal },
      );
      response.on("text", (delta) => {
        chain = chain.then(async () => {
          if (!delta || aborted) return;
          if (!wroteThisRound && sentText) await emit({ type: "text", text: "\n\n" });
          wroteThisRound = true;
          sentText = true;
          await emit({ type: "text", text: delta });
        });
      });
      try {
        const final = await response.finalMessage();
        await chain;
        return final;
      } catch (e) {
        await chain.catch(() => undefined);
        throw e;
      }
    };

    let errorMessage: string | null = null;
    try {
      const budget = newToolBudget();
      for (let round = 0; round < MAX_TURNS; round++) {
        if (aborted) return;
        const final = await complete();
        if (aborted) return;
        logUsage(final.usage);
        if (final.stop_reason === "refusal") {
          errorMessage = REFUSAL;
          break;
        }
        if (final.stop_reason === "max_tokens") break;
        const toolUses = final.content.filter(isToolUse);
        if (toolUses.length === 0) break;

        let endTurn = false;
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of toolUses) {
          const effect: ToolEffect = executeTool(call.name, call.input, budget);
          if (effect.action) await emit({ type: "action", action: effect.action });
          if (effect.endTurn) endTurn = true;
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: effect.content,
            ...(effect.isError ? { is_error: true } : {}),
          });
        }
        if (aborted) return;
        if (endTurn || round === MAX_TURNS - 1) break;
        // 応答の content は thinking を含めて、そのまま次の依頼に返す。
        messages.push({ role: "assistant", content: final.content as Anthropic.MessageParam["content"] });
        messages.push({ role: "user", content: results });
      }
    } catch (e) {
      if (aborted || isAbortError(e)) return;
      errorMessage = publicError(e);
    }
    if (aborted) return;
    await finish(errorMessage);
  });
}
