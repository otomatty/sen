// AI アシスタントの設定。キーが無いときとデモ版では使わない。

import type { Env } from "../env";

const DEFAULT_DAILY_LIMIT = 30;

export interface AssistantConfig {
  apiKey: string;
  /** DEV_TOOLS=1 のときだけ。E2E の模擬サーバーの origin */
  baseURL?: string;
  dailyLimit: number;
}

/** キーが無い、またはデモ版（DEMO_MODE=1）のときは null */
export function assistantConfig(env: Env): AssistantConfig | null {
  if (env.DEMO_MODE === "1") return null;
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  const baseURL = testBaseURL(env);
  const dailyLimit = dailyLimitOf(env.ASSISTANT_DAILY_LIMIT);
  return baseURL ? { apiKey, baseURL, dailyLimit } : { apiKey, dailyLimit };
}

/** 省略時と、正の整数でないときは 30 */
function dailyLimitOf(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DAILY_LIMIT;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_DAILY_LIMIT;
  return n;
}

/**
 * DEV_TOOLS が "1" のときだけ有効。
 * 模擬サーバーの origin を SDK の baseURL にする。本番では無視する。
 */
function testBaseURL(env: Env): string | undefined {
  if (env.DEV_TOOLS !== "1") return undefined;
  const origin = env.ANTHROPIC_API_ORIGIN_FOR_TESTS?.trim().replace(/\/+$/, "") ?? "";
  return origin || undefined;
}
