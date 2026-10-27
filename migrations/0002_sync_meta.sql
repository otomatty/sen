-- 同期ログの掃除（30日より古い行を削除）に伴う管理テーブル。
-- pruned_before より前の差分を持つクライアントには、全体の読み込み直しを指示する。
CREATE TABLE IF NOT EXISTS sync_meta (
  workspace_id TEXT PRIMARY KEY,
  pruned_before INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_created ON sync_log(created_at);
