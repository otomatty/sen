-- AI ツール（MCP）から接続するための個人用トークン。トークンそのものは保存せず、SHA-256 のハッシュだけを持つ
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  client TEXT NOT NULL,
  scope TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON api_tokens(workspace_id, user_id);

-- AI ツールから行った操作の印（例: "Claude Code"）。人が画面から行った操作は NULL
ALTER TABLE activities ADD COLUMN via TEXT;
ALTER TABLE comments ADD COLUMN via TEXT;
ALTER TABLE notifications ADD COLUMN via TEXT;
