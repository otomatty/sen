// 着手日を課題 ID ごとに返す。スプレッドシート連携とアプリで同じ計算を使う。

import { todayYmd } from "../shared/dates";
import { all } from "./db";

/**
 * アーカイブされておらず、プロジェクトのある課題について、次のうちいちばん早い時刻を
 * 日本時間の 'YYYY-MM-DD' にしたもの。どれも無ければその課題は結果に含めない。
 * - issues.started_at
 * - 進行中・完了へ移した state 履歴の created_at。遷移先の種類は data.toType、無ければ今のステータス
 * - 作成時が進行中・完了だった created 履歴の created_at（data.stateType）
 * - state 履歴の data.startedAt（数値のとき）。状態を戻して消えた着手時刻
 * バックログや未着手に戻すと started_at は消えるので、履歴も見る。
 */
export async function loadStartedOn(db: D1Database, workspaceId: string): Promise<Record<string, string>> {
  const [issues, starts, recordedStarts] = await Promise.all([
    all<{ id: string; started_at: number | null }>(
      db,
      "SELECT id, started_at FROM issues WHERE workspace_id = ? AND archived_at IS NULL AND project_id IS NOT NULL",
      workspaceId,
    ),
    all<{ issue_id: string; at: number }>(
      db,
      `SELECT a.issue_id AS issue_id, MIN(a.created_at) AS at
       FROM issues i
       JOIN activities a ON a.issue_id = i.id AND a.type IN ('state', 'created')
       LEFT JOIN workflow_states s ON s.workspace_id = i.workspace_id AND s.id = json_extract(a.data, '$.to')
       WHERE i.workspace_id = ? AND i.archived_at IS NULL AND i.project_id IS NOT NULL
         AND (
           (a.type = 'state' AND COALESCE(json_extract(a.data, '$.toType'), s.type) IN ('started', 'completed'))
           OR (a.type = 'created' AND json_extract(a.data, '$.stateType') IN ('started', 'completed'))
         )
       GROUP BY a.issue_id`,
      workspaceId,
    ),
    all<{ issue_id: string; at: number }>(
      db,
      `SELECT a.issue_id AS issue_id, MIN(json_extract(a.data, '$.startedAt')) AS at
       FROM issues i
       JOIN activities a ON a.issue_id = i.id AND a.type = 'state'
       WHERE i.workspace_id = ? AND i.archived_at IS NULL AND i.project_id IS NOT NULL
         AND json_type(a.data, '$.startedAt') IN ('integer', 'real')
       GROUP BY a.issue_id`,
      workspaceId,
    ),
  ]);

  const startedAt = new Map(starts.map((row) => [row.issue_id, row.at]));
  const recordedStartedAt = new Map(recordedStarts.map((row) => [row.issue_id, row.at]));
  const startedOn: Record<string, string> = {};
  for (const issue of issues) {
    const startedMs = earlier(earlier(finite(issue.started_at), finite(startedAt.get(issue.id))), finite(recordedStartedAt.get(issue.id)));
    if (startedMs != null) startedOn[issue.id] = todayYmd(540, startedMs);
  }
  return startedOn;
}

function earlier(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
