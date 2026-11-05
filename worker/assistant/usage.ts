// 利用者ごと・日本時間の日ごとの質問回数。同時に来ても上限を超えないよう、増やすのは 1 つの SQL だけ。

import { todayYmd } from "../../shared/dates";
import { first, run } from "../db";

export interface QuotaResult {
  ok: boolean;
  remaining: number;
  day: string;
}

function dayOf(now: number): string {
  return todayYmd(540, now);
}

/**
 * 1 回分を使う。上限なら行を増やさない。
 * INSERT ... ON CONFLICT DO UPDATE ... WHERE count < ? RETURNING は、
 * 条件を満たさない更新では行を返さない。
 */
export async function consumeQuota(db: D1Database, userId: string, limit: number, now: number): Promise<QuotaResult> {
  const day = dayOf(now);
  const row = await first<{ count: number }>(
    db,
    `INSERT INTO assistant_usage (user_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?
     RETURNING count`,
    userId,
    day,
    limit,
  );
  if (!row) return { ok: false, remaining: 0, day };
  return { ok: true, remaining: Math.max(0, limit - Number(row.count)), day };
}

/** 1 回分を戻す。0 未満にはしない。AI が何も返せなかったときに使う */
export async function refundQuota(db: D1Database, userId: string, day: string): Promise<void> {
  await run(db, "UPDATE assistant_usage SET count = count - 1 WHERE user_id = ? AND day = ? AND count > 0", userId, day);
}

export async function remainingQuota(db: D1Database, userId: string, limit: number, now: number): Promise<number> {
  const row = await first<{ used: number }>(
    db,
    "SELECT count AS used FROM assistant_usage WHERE user_id = ? AND day = ?",
    userId,
    dayOf(now),
  );
  return Math.max(0, limit - Number(row?.used ?? 0));
}
