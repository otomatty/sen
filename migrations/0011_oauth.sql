-- OAuth クライアント。DCR と CIMD のメタデータを保持する
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  secret_hash TEXT,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER
);
-- 同意画面に渡す一時リクエスト
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- 一度だけ交換できる認可コードのハッシュ
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  grant_id TEXT
);
-- 利用者が管理する接続。再送のため一つ前のリフレッシュも照合する
CREATE TABLE IF NOT EXISTS oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  client_name TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  prev_refresh_hash TEXT,
  refresh_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
-- アクセストークンのハッシュ
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_grants_workspace_user ON oauth_grants(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS oauth_grants_prev_refresh ON oauth_grants(prev_refresh_hash);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_grant ON oauth_access_tokens(grant_id);
CREATE INDEX IF NOT EXISTS oauth_grants_client ON oauth_grants(client_id);
