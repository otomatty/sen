// /api/assistant の入口。登録は worker/app.ts。ここから先はデモ版のビルドでは読み込まない。

import type { Context } from "hono";
import type { AppEnv } from "../env";
import { streamAssistant } from "./chat";
import { assistantConfig } from "./config";
import { parseAssistantRequest, toModelMessages } from "./request";
import { consumeQuota, remainingQuota } from "./usage";

const DISABLED = { enabled: false, limit: 0, remaining: 0 };

export async function assistantStatus(c: Context<AppEnv>): Promise<Response> {
  const cfg = assistantConfig(c.env);
  if (!cfg) return c.json(DISABLED);
  const remaining = await remainingQuota(c.env.DB, c.get("user").id, cfg.dailyLimit, Date.now());
  return c.json({ enabled: true, limit: cfg.dailyLimit, remaining });
}

export async function assistantChat(c: Context<AppEnv>): Promise<Response> {
  const cfg = assistantConfig(c.env);
  if (!cfg) return c.json({ error: "AI アシスタントは使えません" }, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "形式が正しくありません" }, 400);
  }
  const parsed = parseAssistantRequest(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const modelMessages = toModelMessages(parsed.value.messages, parsed.value.screen);
  if (modelMessages.length === 0 || modelMessages[modelMessages.length - 1]?.role !== "user") {
    return c.json({ error: "質問を入力してください" }, 400);
  }

  const quota = await consumeQuota(c.env.DB, c.get("user").id, cfg.dailyLimit, Date.now());
  if (!quota.ok) {
    return c.json({ error: `今日の質問の上限（${cfg.dailyLimit} 回）に達しました。明日またお試しください。` }, 429);
  }
  return streamAssistant(c, cfg, modelMessages, quota);
}
