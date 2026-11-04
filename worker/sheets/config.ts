// スプレッドシート連携の設定と、Durable Object への依頼。
// ブラウザ内デモ（demo/backend.ts → worker/app.ts）からも読み込まれるため、
// cloudflare:workers や Node の API は使わない。
// DB は worker/db.ts のヘルパーだけ使う（app.ts が既に読み込んでいる）。
// 鍵 JSON の解析は実行時に google.ts で行う。

import type { EntityName, SheetSyncStatus } from "../../shared/types";
import { first } from "../db";
import type { Env, WorkspaceRow } from "../env";
import type { Change } from "../sync";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API_BASE = "https://sheets.googleapis.com";
const DEFAULT_DELAY_MS = 30_000;

export interface SheetsConfig {
  workspaceKey: string;
  spreadsheetId: string;
  delayMs: number;
  /** アクセストークンを取りに行く URL（本番は Google、テスト時は模擬サーバー） */
  tokenUrl: string;
  /** Sheets API のオリジン（パスは付けない。呼び出し側が /v4/spreadsheets を足す） */
  sheetsApiBase: string;
}

/** 3 つの設定と REALTIME が揃っていれば連携設定を返す。欠けていれば null（何もしない） */
export function sheetsConfig(env: Env): SheetsConfig | null {
  const workspaceKey = env.SHEETS_WORKSPACE?.trim() ?? "";
  const spreadsheetId = env.SHEETS_SPREADSHEET_ID?.trim() ?? "";
  const key = env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim() ?? "";
  if (!workspaceKey || !spreadsheetId || !key || !env.REALTIME) return null;

  const endpoints = googleEndpoints(env);
  return {
    workspaceKey,
    spreadsheetId,
    delayMs: syncDelayMs(env.SHEETS_SYNC_DELAY_MS),
    tokenUrl: endpoints.tokenUrl,
    sheetsApiBase: endpoints.sheetsApiBase,
  };
}

export function spreadsheetUrl(id: string): string {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}

/** 連携が有効で、このワークスペースが対象か */
export function isSheetsTarget(env: Env, wsUrlKey: string): boolean {
  const cfg = sheetsConfig(env);
  return cfg !== null && cfg.workspaceKey === wsUrlKey;
}

/** 反映のやり直しが必要になるエンティティ */
export const REPORT_ENTITIES = new Set<EntityName>(["project", "issue", "state", "user", "team", "label", "workspace"]);

/**
 * 対象ワークスペースの課題・プロジェクト等を保存したあとに呼ぶ。
 * 別のワークスペースでも、対象のメンバーであるユーザーの変更なら予約する
 * （ユーザー名はワークスペースをまたいで共有されるため）。
 * 約 delayMs 後に反映するよう Durable Object へ予約する。失敗しても例外は出さない。
 */
export async function scheduleSheetSync(env: Env, ws: WorkspaceRow, changes: Change[], origin: string): Promise<void> {
  const cfg = sheetsConfig(env);
  if (!cfg) return;

  if (cfg.workspaceKey === ws.url_key) {
    if (!changes.some((ch) => REPORT_ENTITIES.has(ch.entity))) return;
    await sendSchedule(env, ws.id, origin);
    return;
  }

  const userIds = [...new Set(changes.filter((ch) => ch.entity === "user").map((ch) => ch.entityId))];
  if (userIds.length === 0) return;
  try {
    // D1 は 1 つの問い合わせでバインドが 100 個まで。url_key の分を残し、ユーザー ID は 99 個ずつ調べる。
    const chunkSize = 99;
    for (let i = 0; i < userIds.length; i += chunkSize) {
      const chunk = userIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const target = await first<{ id: string }>(
        env.DB,
        `SELECT w.id FROM workspaces w JOIN members m ON m.workspace_id = w.id WHERE w.url_key = ? AND m.user_id IN (${placeholders}) LIMIT 1`,
        cfg.workspaceKey,
        ...chunk,
      );
      if (!target) continue;
      await sendSchedule(env, target.id, origin);
      return;
    }
  } catch (e) {
    console.error("sheets schedule failed", e);
  }
}

/** 対象ワークスペースの Durable Object に反映を予約する。失敗しても例外は出さない。 */
async function sendSchedule(env: Env, workspaceId: string, origin: string): Promise<void> {
  const ns = env.REALTIME;
  if (!ns) return;
  try {
    const stub = ns.get(ns.idFromName(workspaceId));
    await stub.fetch("https://realtime/sheets/schedule", {
      method: "POST",
      body: JSON.stringify({ origin }),
    });
  } catch (e) {
    console.error("sheets schedule failed", e);
  }
}

/** 今すぐ反映する。Durable Object の /sheets/run が SheetSyncStatus を返す */
export async function requestSheetSyncNow(env: Env, wsId: string, origin: string): Promise<SheetSyncStatus> {
  const res = await realtime(env, wsId).fetch("https://realtime/sheets/run", {
    method: "POST",
    body: JSON.stringify({ origin }),
  });
  return (await res.json()) as SheetSyncStatus;
}

/** 反映の状態を読む。Durable Object の /sheets/status */
export async function requestSheetSyncStatus(env: Env, wsId: string): Promise<SheetSyncStatus> {
  const res = await realtime(env, wsId).fetch("https://realtime/sheets/status");
  return (await res.json()) as SheetSyncStatus;
}

function realtime(env: Env, wsId: string) {
  if (!env.REALTIME) throw new Error("リアルタイム同期は無効です");
  return env.REALTIME.get(env.REALTIME.idFromName(wsId));
}

function googleEndpoints(env: Env): { tokenUrl: string; sheetsApiBase: string } {
  const override = env.DEV_TOOLS === "1" ? env.GOOGLE_API_ORIGIN_FOR_TESTS?.trim() : "";
  const origin = override?.replace(/\/+$/, "") ?? "";
  if (origin) return { tokenUrl: `${origin}/oauth2/token`, sheetsApiBase: origin };
  return { tokenUrl: TOKEN_URL, sheetsApiBase: SHEETS_API_BASE };
}

/** 省略・不正な値は 30 秒。0 は「待たずに反映」として許す */
function syncDelayMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DELAY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DELAY_MS;
  return n;
}
