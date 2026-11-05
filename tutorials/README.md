# 使い方動画の自動収録

Sen の使い方動画は、人が画面を録画するのではなく、**AI が書いたシナリオをヘッドレスブラウザが実行して自動で撮影**します。画面を変更したら `bun run tutorials` を実行するだけで、すべての動画が最新の画面で撮り直されます。

```
tutorials/
  run.ts            収録の司令塔（ビルド → 起動 → デモデータ投入 → 各シナリオを録画 → MP4 化 → manifest 出力）
  lib/
    director.ts     シナリオから使う操作 API（カーソル移動・クリック・入力・キー表示・字幕・強調）
    google-mock.ts  収録用の模擬 Google（OAuth トークンと Sheets API）
    narration.ts    字幕とタイトルカードの読み上げ（Gemini TTS）と、映像への合成
    overlay.ts      ページに重ねる表示（カーソル・クリックの波紋・押したキー・字幕・タイトル）
    recorder.ts     Chrome DevTools Protocol のスクリーンキャストで録画し、ffmpeg で H.264 に変換
    types.ts        シナリオの型
  scenarios/        1 ファイル = 1 本の動画
```

## 操作 API（`t`）

| メソッド | 説明 |
| --- | --- |
| `t.caption(text, { hold?, say? })` | 字幕を表示し、動画のチャプター（ステップ）として記録。少し待ってすぐ操作に移り、読み終わる時間は次の字幕の前に確保する（操作の結果が字幕と一緒に映る）。`say` があれば、画面の字幕ではなくその文を読み上げる |
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
- 1 本 40〜70 秒、字幕は 1 文 30 文字程度までのやさしい日本語
- 字幕はそのまま読み上げられるので、声に出して自然な文にする
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
6. 字幕とタイトルカードの読み上げを AAC で重ねる（`--no-narration` のときは付けない）
7. `public/tutorials/manifest.json` にタイトル・説明・長さ・チャプター時刻・ナレーションの有無（`narration`）と、収録時の画面のハッシュ（`sourceHash`）を書き込む

`t.expect` が 1 つでも失敗したシナリオは動画を書き出さず、終了コード 1 で終わります。

## 動画が古くなっていないか確かめる

```bash
bun run tutorials:check
```

`src/`・`tutorials/lib/`・シナリオのどれかが収録時から変わっていると、撮り直しが必要な動画を一覧にします（CI でも警告として表示されます）。ナレーションの付いていない動画も、同じ一覧に入ります。

アプリは manifest を読み、各画面右上の「▶ 使い方」とヘルプ画面に動画を表示します。

## スプレッドシート連携の動画

シナリオが `export const sheets = true` を宣言していると、その動画にはスプレッドシート連携が必要だとみなします。収録は模擬の Google（`tutorials/lib/google-mock.ts`）を起動し、デモデータの初期化が終わってから、連携を有効にしたサーバーで撮ります。本物の Google にはつながりません。`--url` では模擬の Google を使えないので、この動画は撮れません。

シートの中身は、アプリが実際に送った書き込み（batchUpdate）から模擬サーバーが組み立てたものです。シナリオからは `googleMock.snapshot()` で読めます。

## ナレーション

字幕（`t.caption`）とタイトルカード（`t.title`）は、Gemini の TTS モデルで読み上げて MP4 に重ねます。読み上げは字幕が出た瞬間に始まり、読み終わるまで次の字幕へ進みません。タイトルカードは「見出し。要約」を読みます（見出しがすでに「。」で終わっていれば、句点は重ねません）。

`GEMINI_API_KEY` が無く、`--no-narration` も無いときは、ビルドや起動の前に終了コード 1 で止まります。

```
GEMINI_API_KEY が設定されていません。ナレーションなしで撮るときは --no-narration を付けてください
```

API キーの値は、ログにもエラーにもファイルにも出しません。

### 環境変数

| 変数 | 既定 | 内容 |
| --- | --- | --- |
| `GEMINI_API_KEY` | （なし。ナレーションには必須） | Gemini API のキー |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-tts` | TTS のモデル名。未設定か空なら既定 |
| `GEMINI_TTS_VOICE` | `Kore` | 声。未設定か空なら既定 |
| `GEMINI_TTS_STYLE` | 下の指示文 | 読み上げ方の指示。未設定か空なら既定。送る本文は「指示文 + 改行 + 読み上げ文」 |
| `GEMINI_TTS_CONCURRENCY` | `3` | 先読みの同時リクエスト数。1 未満、または数値として読めないときは 3 |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com` | API のベース URL（テストやプロキシ用） |

`GEMINI_TTS_STYLE` の既定:

```
Read the following Japanese narration aloud for a software tutorial video. Use a calm, warm and clear voice at a relaxed, slightly slow pace. Read only the transcript.

TRANSCRIPT:
```

開始時のログにはモデルと声だけが出ます（例: `gemini-3.8-flash-tts / Kore`）。

### キャッシュ

同じ文を何度も API に送らないよう、読み上げ済みの PCM を OS の一時ディレクトリに置きます。場所は `os.tmpdir()` の `sen-tutorials/_narration` です（Linux では `/tmp/sen-tutorials/_narration`）。ファイル名は `{ v: 2, baseUrl, model, voice, style, speech }` の JSON を sha256 した値です。`speech` は読み替えたあとの文です。API のベース URL（`GEMINI_API_BASE_URL`）も含むので、模擬サーバーで試した音声が本物の API での収録に混ざりません。ベース URL・声・モデル・指示文のどれかを変えると、別のファイルになります。

収録の前に、各シナリオのタイトルと、ソースから集めた字幕を先に読み上げてキャッシュします（ビルドやサーバー起動と並行。進捗は「ナレーションを準備しています（12/108）」のように出ます）。キャッシュに無い文を収録の途中で取りに行くときは、そのあいだ録画を止めます。API の待ち時間は動画に入りません。

`--speed` は操作の待ちだけを変えます。読み上げの長さは倍率で割りません。

### 記号の読み替えと `say`

字幕の記号は、読み上げの前に言い換えます。`+` は前後の空白ごと「プラス」になります。連続する空白は 1 つにまとめ、前後は削ります。

| 字幕 | 読み上げ |
| --- | --- |
| `⌘K（Ctrl+K）のパレットから` | `コマンド K、または コントロール プラス Kのパレットから` |
| `⇧` / `⌥` | `シフト` / `オプション` |
| `G → I` | `G のあとに I` |
| `J / K` | `J と K`（英字 1 文字どうしの ` / `） |
| `/ キー`（先頭、または空白のあと） | `スラッシュキー` |
| `↓` `↑` `←` `→` | `下矢印キー` `上矢印キー` `左矢印キー` `右矢印キー`。空白で挟んだ `→` は「のあとに」 |
| `★` `×` `@` | `星のマーク` `バツ` `アットマーク` |
| `? を押す` | `はてなキー を押す` |
| `Esc` / `Sen` | `エスケープ` / `セン`（単語の途中は変えない。`Sentry` はそのまま） |
| `##` | `シャープ 2 つ`（うしろの空白は残る。`## で` は `シャープ 2 つ で`） |
| `、- で` / 先頭の `- で` | `、ハイフンで` / `ハイフンで` |
| `（1 = 緊急）` | `（1 は緊急）` |

画面に出す文と、読んで自然な文が違うときは `say` を付けます。画面は第 1 引数のまま、読み上げは `say` です。`say` の文も、上の読み替えを通ります。

```ts
await t.caption("説明は Markdown で書けます。## で見出し、- で箇条書き", {
  say: "説明は Markdown で書けます。シャープ 2 つで見出し、ハイフンで箇条書き",
});
```

## オプション

```bash
bun run tutorials -- board inbox        # id の一部で絞り込み
bun run tutorials -- --skip-build       # ビルド済みなら省略
bun run tutorials -- --keep-frames      # 録画したフレーム画像を残す（調査用）
bun run tutorials -- --url http://...   # 起動済みの環境で収録（DEV_TOOLS=1 が必要）
bun run tutorials -- --no-narration     # ナレーションなしで撮る（API キーがなくても撮れる）
bun run tutorials -- --speed 0.8        # 操作の速さ。既定は 1。0.8 なら 2 割ゆっくり。正の数以外はエラー
```
