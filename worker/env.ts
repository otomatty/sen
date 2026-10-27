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
