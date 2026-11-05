import type { Me, Role } from "../shared/types";

export interface RealtimeNotifier {
  notify(workspaceId: string, lastSyncId: number): Promise<void>;
}

export interface Env {
  DB: D1Database;
  REALTIME?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  /** "1" のとき /api/dev/* を有効化（ローカル開発・動画収録・デモ用） */
  DEV_TOOLS?: string;
  /** "1" のとき Authorization: Bearer でのセッションを許可（ブラウザ内デモ用） */
  DEMO_MODE?: string;
  /** セッションの署名などに使う秘密の値（本番では必須。`wrangler secret put BETTER_AUTH_SECRET`） */
  BETTER_AUTH_SECRET?: string;
  /** 公開している URL（例: https://sen.example.com）。省略時はリクエストの URL から決める */
  BETTER_AUTH_URL?: string;
  /** Google Cloud の OAuth クライアント（ログインに使う） */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** スプレッドシート連携の対象ワークスペース（url_key。例: "ses"） */
  SHEETS_WORKSPACE?: string;
  /** 書き込み先のスプレッドシート ID */
  SHEETS_SPREADSHEET_ID?: string;
  /** サービスアカウントの鍵（Google が発行する JSON をそのまま。client_email と private_key を使う） */
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
  /** 保存から反映までの待ち時間（ミリ秒）。省略時は 30000 */
  SHEETS_SYNC_DELAY_MS?: string;
  /**
   * DEV_TOOLS が "1" のときだけ有効。
   * 設定されていれば Google の代わりにこのオリジンへ送る（E2E の模擬サーバー用）。本番では無視する。
   */
  GOOGLE_API_ORIGIN_FOR_TESTS?: string;
  /** GitHub 連携の対象ワークスペース（url_key。例: "ses"） */
  GITHUB_WORKSPACE?: string;
  /** 個人のアクセストークン。画面・ログ・同期ログには出さない */
  GITHUB_TOKEN?: string;
  /** Webhook の secret。画面・ログ・同期ログには出さない */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Sen の変更を GitHub に送るまでの待ち時間（ミリ秒）。省略時は 3000 */
  GITHUB_SYNC_DELAY_MS?: string;
  /**
   * DEV_TOOLS が "1" のときだけ有効。
   * 設定されていれば https://api.github.com の代わりにこのオリジンへ送る（E2E の模擬サーバー用）。本番では無視する。
   */
  GITHUB_API_ORIGIN_FOR_TESTS?: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  url_key: string;
  invite_code: string;
  created_at: number;
  updated_at: number;
}

export type AppVars = {
  user: Me;
  workspace: WorkspaceRow;
  role: Role;
};

export type AppEnv = { Bindings: Env; Variables: AppVars };
