# 使い方動画の自動収録

Sen の使い方動画は、人が画面を録画するのではなく、**AI が書いたシナリオをヘッドレスブラウザが実行して自動で撮影**します。画面を変更したら `bun run tutorials` を実行するだけで、すべての動画が最新の画面で撮り直されます。

```
tutorials/
  run.ts            収録の司令塔（ビルド → 起動 → デモデータ投入 → 各シナリオを録画 → MP4 化 → manifest 出力）
  lib/
    director.ts     シナリオから使う操作 API（カーソル移動・クリック・入力・キー表示・字幕・強調）
    overlay.ts      ページに重ねる表示（カーソル・クリックの波紋・押したキー・字幕・タイトル）
    recorder.ts     Chrome DevTools Protocol のスクリーンキャストで録画し、ffmpeg で H.264 に変換
    types.ts        シナリオの型
  scenarios/        1 ファイル = 1 本の動画
```

## 操作 API（`t`）

| メソッド | 説明 |
| --- | --- |
| `t.caption(text, { hold? })` | 字幕を表示し、動画のチャプター（ステップ）として記録。少し待ってすぐ操作に移り、読み終わる時間は次の字幕の前に確保する（操作の結果が字幕と一緒に映る） |
| `t.expect(selector, { text?, hidden?, count? })` | 操作の結果を確かめる。期待どおりでなければ**収録を失敗させる**（壊れた動画を公開しないため） |
| `t.expectUrl(/正規表現/)` | 画面の移動を確かめる |
| `t.poster()` | 一覧に出すサムネイルを、字幕なしでこの瞬間の画面から撮る |
| `t.park()` | カーソルを邪魔にならない場所へ移す（キーボード操作の前に） |
| `t.click(selector)` | カーソルを滑らかに動かしてクリック（波紋を表示） |
| `t.hover(selector)` | カーソルを移動してとどまる |
| `t.type(text)` | 人が打つ速さで入力（日本語も可） |
| `t.press("Meta+k")` / `t.press("g i")` | キーを押し、押したキーを画面に大きく表示（2 打鍵のシーケンスも可） |
| `t.highlight(selector)` | 要素を光らせて注目させる |
| `t.drag(from, to)` | ドラッグ＆ドロップ |
| `t.scroll(selector, dy)` | スクロール |
| `t.goto(path)` | ワークスペース内の画面へ移動 |
| `t.wait(ms)` | 待つ |

セレクタは `data-testid` を優先して使います（E2E テストと共通）。

## 新しい動画を AI に作らせるには

Claude などの AI に、次のように依頼すると新しいシナリオを書いてもらえます。

```
tutorials/scenarios/ に、Sen の「〇〇」画面の使い方動画のシナリオを追加してください。
- 既存のシナリオ（例: 02-create-issue.ts）と同じ書き方で、defineScenario を使う
- 1 本 30〜50 秒、字幕は 1 文 30 文字程度までのやさしい日本語
- 各ステップで「何を押すと、何が起きるか」が画面上で分かるようにする
- 操作のあとに t.expect で結果を確かめ、いちばん分かりやすい瞬間で t.poster() を呼ぶ
- セレクタは src/ の data-testid を使う
- 書いたら `bun run tutorials -- <id>` で収録し、動画のフレームを確認して不自然な点を直す
```

AI は画面のコードを読んで操作手順を組み立て、収録した動画のフレームを見て自分で手直しできます（このリポジトリの動画もその方法で作られています）。

## 収録の流れ

1. `vite build` で本番と同じビルドを作る
2. `vite preview` を、まっさらなローカル D1（`/tmp/sen-tutorials/state`）で起動
3. 開発用のログイン（`/api/auth/dev/sign-in`。Google を通さない）でデモ用アカウントに入り、シナリオごとに `/api/dev/seed-demo` でデータを初期状態に戻す（どちらも `DEV_TOOLS=1` のときだけ有効）
4. Chromium（1280×800・1.5 倍）で開き、Mac として振る舞わせて `⌘` 表記にそろえる
5. CDP スクリーンキャストで録画 → ffmpeg で 30fps / 1600×1000 / H.264 に変換、サムネイルも書き出す
6. `public/tutorials/manifest.json` にタイトル・説明・長さ・チャプター時刻と、収録時の画面のハッシュ（`sourceHash`）を書き込む

`t.expect` が 1 つでも失敗したシナリオは動画を書き出さず、終了コード 1 で終わります。

## 動画が古くなっていないか確かめる

```bash
bun run tutorials:check
```

`src/`・`tutorials/lib/`・シナリオのどれかが収録時から変わっていると、撮り直しが必要な動画を一覧にします（CI でも警告として表示されます）。

アプリは manifest を読み、各画面右上の「▶ 使い方」とヘルプ画面に動画を表示します。

## オプション

```bash
bun run tutorials -- board inbox        # id の一部で絞り込み
bun run tutorials -- --skip-build       # ビルド済みなら省略
bun run tutorials -- --keep-frames      # 録画したフレーム画像を残す（調査用）
bun run tutorials -- --url http://...   # 起動済みの環境で収録（DEV_TOOLS=1 が必要）
```
