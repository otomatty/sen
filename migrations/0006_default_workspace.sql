-- アプリを開いたとき、最初に表示するワークスペース（アカウント単位。未設定は NULL）
ALTER TABLE users ADD COLUMN default_workspace_id TEXT;
