-- 課題どうしの関係（ブロック・関連・重複）。元の課題に JSON 配列で保存する。
ALTER TABLE issues ADD COLUMN relations TEXT NOT NULL DEFAULT '[]';
