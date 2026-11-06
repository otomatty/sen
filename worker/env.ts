import type { Me, Role } from "../shared/types";

export interface RealtimeNotifier {
  notify(workspaceId: string, lastSyncId: number): Promise<void>;
}

export interface Env {
  DB: D1Database;
  REALTIME?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  /** 招待メールの送信に使う（Cloudflare Email Service）。送信元のドメインを Email Sending に登録し、INVITE_EMAIL_FROM を設定したときだけ送る */
  EMAIL?: SendEmail;
  /** 招待メールの送信元アドレス（例: noreply@sen.example.com）。EMAIL と両方そろったときだけ送る */
  INVITE_EMAIL_FROM?: string;
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
  /** Claude API のキー（`wrangler secret put ANTHROPIC_API_KEY`）。無ければ AI アシスタントは無効 */
  ANTHROPIC_API_KEY?: string;
  /** 1 人が 1 日（日本時間）に質問できる回数。省略時は 30。正の整数でなければ 30 */
  ASSISTANT_DAILY_LIMIT?: string;
  /**
   * DEV_TOOLS が "1" のときだけ有効。
   * E2E の模擬サーバーの origin（例: http://localhost:4330）。SDK の baseURL に渡す。本番では無視する。
   */
  ANTHROPIC_API_ORIGIN_FOR_TESTS?: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  url_key: string;
  /** 利用できるメールドメインの JSON 配列。空配列なら制限なし */
  allowed_domains: string;
  created_at: number;
  updated_at: number;
}

export type AppVars = {
  user: Me;
  /** Google（または開発用ログイン）がメールアドレスを確認済みか */
  emailVerified: boolean;
  workspace: WorkspaceRow;
  role: Role;
};

export type AppEnv = { Bindings: Env; Variables: AppVars };
