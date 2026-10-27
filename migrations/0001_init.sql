-- Sen 初期スキーマ（Cloudflare D1 / SQLite）
-- 日時はすべて UNIX ミリ秒（INTEGER）、日付のみの値は 'YYYY-MM-DD'（TEXT）。

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL UNIQUE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  color TEXT NOT NULL,
  issue_count INTEGER NOT NULL DEFAULT 0,
  cycle_duration INTEGER NOT NULL DEFAULT 2,
  cycles_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS workflow_states (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color TEXT NOT NULL,
  position REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_states_ws ON workflow_states(workspace_id);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_labels_ws ON labels(workspace_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  lead_id TEXT,
  team_ids TEXT NOT NULL DEFAULT '[]',
  start_date TEXT,
  target_date TEXT,
  color TEXT NOT NULL,
  icon TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  name TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycles_ws ON cycles(workspace_id);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  assignee_id TEXT,
  creator_id TEXT NOT NULL,
  project_id TEXT,
  cycle_id TEXT,
  parent_id TEXT,
  label_ids TEXT NOT NULL DEFAULT '[]',
  subscriber_ids TEXT NOT NULL DEFAULT '[]',
  estimate INTEGER,
  due_date TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  canceled_at INTEGER,
  archived_at INTEGER,
  UNIQUE (team_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_ws ON issues(workspace_id);
CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_issue ON activities(issue_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  archived_at INTEGER,
  snoozed_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(workspace_id, user_id);

-- 差分同期ログ。クライアントは lastSyncId 以降の変更だけを取得する。
-- user_id が NULL の行はワークスペース全員に、値がある行はそのユーザーにだけ配信される。
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  data TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_ws ON sync_log(workspace_id, id);
