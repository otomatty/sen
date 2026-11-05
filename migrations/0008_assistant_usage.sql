-- AI アシスタントの利用回数（利用者ごと・日本時間の日ごと）
CREATE TABLE IF NOT EXISTS assistant_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
