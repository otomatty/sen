-- 添付ファイル。本体は R2 の <workspace_id>/<id> に置く
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  unreferenced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attachments_ws ON attachments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploader_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attachments_unref ON attachments(unreferenced_at);

-- どの本文がどの添付を使っているか（owner_type: issue / comment / project）
CREATE TABLE IF NOT EXISTS attachment_refs (
  attachment_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  PRIMARY KEY (attachment_id, owner_type, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_attachment_refs_owner ON attachment_refs(owner_type, owner_id);
