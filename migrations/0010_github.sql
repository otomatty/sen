ALTER TABLE users ADD COLUMN github_login TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login);
ALTER TABLE comments ADD COLUMN github_author TEXT;

CREATE TABLE IF NOT EXISTS github_repos (
  team_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  hook_id INTEGER,
  pr_draft_state_id TEXT,
  pr_open_state_id TEXT,
  pr_merged_state_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_repos_ws ON github_repos(workspace_id);

CREATE TABLE IF NOT EXISTS github_issue_links (
  issue_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  base_title TEXT NOT NULL,
  base_body TEXT NOT NULL,
  base_state TEXT NOT NULL,
  base_labels TEXT NOT NULL DEFAULT '[]',
  base_assignee TEXT,
  synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_github_issue_links_ws ON github_issue_links(workspace_id);

CREATE TABLE IF NOT EXISTS github_comment_links (
  comment_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  github_comment_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS github_pull_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  author TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (issue_id, repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_github_pull_links_ws ON github_pull_links(workspace_id);

CREATE TABLE IF NOT EXISTS github_deliveries (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- 作成の POST は通ったのに、応答や紐づけが失われたときのやり直し。
-- 記録があるときだけ GitHub を読み、同じものを二重に作らない。
CREATE TABLE IF NOT EXISTS github_sync_attempts (
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id)
);

-- 手で紐づけを外した課題と、GitHub 側で Issue が無くなって外れた課題。
-- 自動では Issue を作り直さない。画面から作る・紐づけると消す。
CREATE TABLE IF NOT EXISTS github_issue_create_skips (
  issue_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 手で外した紐づけと、GitHub で削除・移動されて外れた紐づけ。
-- 自動では取り込まない。画面からその Issue を指定して紐づけると消す。
CREATE TABLE IF NOT EXISTS github_import_skips (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, number)
);

-- 参照先の Issue がまだ取り込まれていないプルリクエスト。
-- 紐づけができたら、そのプルリクエストを順番待ちに戻す。30 日より前のものは毎日の突き合わせで消す。
CREATE TABLE IF NOT EXISTS github_pull_pending_refs (
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  pull_repo_id INTEGER NOT NULL,
  pull_number INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, number, pull_repo_id, pull_number)
);
