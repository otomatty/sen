// スプレッドシート連携の設定と、Durable Object への依頼。
// ブラウザ内デモ（demo/backend.ts → worker/app.ts）からも読み込まれるため、
// cloudflare:workers や Node の API、DB（?raw）には依存しない。
// 鍵 JSON の解析は実行時に google.ts で行う。

import type { EntityName, SheetSyncStatus } from "../../shared/types";
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
export const REPORT_ENTITIES = new Set<EntityName>(["project", "issue", "state", "user", "team", "label"]);

/**
 * 対象ワークスペースの課題・プロジェクト等を保存したあとに呼ぶ。
 * 約 delayMs 後に反映するよう Durable Object へ予約する。失敗しても例外は出さない。
 */
export async function scheduleSheetSync(env: Env, ws: WorkspaceRow, changes: Change[], origin: string): Promise<void> {
  const cfg = sheetsConfig(env);
  if (!cfg || cfg.workspaceKey !== ws.url_key) return;
  if (!changes.some((ch) => REPORT_ENTITIES.has(ch.entity))) return;
  const ns = env.REALTIME;
  if (!ns) return;
  try {
    const stub = ns.get(ns.idFromName(ws.id));
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
