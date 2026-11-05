-- メールアドレスを指定した招待。
-- email は小文字にそろえて保存する。
-- token_hash は招待リンクのトークンの SHA-256（hashToken）。トークン自体は保存しない。
-- invited_by は招待した管理者の user id。
-- email_sent_at は招待メールを送れたとき。accepted_at / accepted_by は参加したとき。revoked_at は取り消したとき。
-- workspaces.allowed_domains は利用できるメールドメインの JSON 配列（空なら制限なし）。
-- workspaces.invite_code は残す（SQLite では UNIQUE 列を簡単に消せない）。どこからも読まない。

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  email_sent_at INTEGER,
  accepted_at INTEGER,
  accepted_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invitations_ws ON invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
ALTER TABLE workspaces ADD COLUMN allowed_domains TEXT NOT NULL DEFAULT '[]';
