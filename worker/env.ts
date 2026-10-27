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
