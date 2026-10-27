import { addDays, mondayOf, todayYmd } from "../shared/dates";
import { batch, first, stmt } from "./db";
import { hashPassword, randomToken } from "./auth";
import { insertTeam } from "./mutations";

type Db = D1Database;
const DAY = 86_400_000;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return s.length >= 2 ? s : "";
}

async function uniqueUrlKey(db: Db, base: string): Promise<string> {
  let key = base || `ws-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  for (let i = 0; i < 20; i++) {
    const exists = await first(db, "SELECT id FROM workspaces WHERE url_key = ?", key);
    if (!exists) return key;
    key = `${base || "ws"}-${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  return `ws-${crypto.randomUUID().slice(0, 8)}`;
}

const p = (...xs: string[]) => xs.map((x) => `<p>${x}</p>`).join("");
const ul = (...xs: string[]) => `<ul>${xs.map((x) => `<li><p>${x}</p></li>`).join("")}</ul>`;
const h = (x: string) => `<h3>${x}</h3>`;

/** 新しいワークスペースを作り、初回体験用のサンプル（使い方を学べる課題）を入れる */
export async function createWorkspace(
  db: Db,
  opts: { name: string; ownerId: string; urlKey?: string },
): Promise<{ id: string; urlKey: string }> {
  const now = Date.now();
  const wsId = crypto.randomUUID();
  const urlKey = await uniqueUrlKey(db, slugify(opts.urlKey ?? opts.name));
  await batch(db, [
    stmt(
      db,
      "INSERT INTO workspaces (id, name, url_key, invite_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      wsId,
      opts.name,
      urlKey,
      randomToken(12),
      now,
      now,
    ),
    stmt(db, "INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)", wsId, opts.ownerId, now),
  ]);

  const teamId = crypto.randomUUID();
  const { stateIds } = await insertTeam(db, wsId, { id: teamId, name: "エンジニアリング", key: "ENG", color: "#6470e8" }, now);

  const labels = {
    bug: crypto.randomUUID(),
    feature: crypto.randomUUID(),
    improvement: crypto.randomUUID(),
  };
  const projectId = crypto.randomUUID();
  const today = todayYmd();
  const cycleStart = mondayOf(today);
  const cycle1 = crypto.randomUUID();
  const cycle2 = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [
    stmt(db, "INSERT INTO labels (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, 'バグ', '#eb5757', ?, ?)", labels.bug, wsId, now, now),
    stmt(db, "INSERT INTO labels (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, '機能', '#a76be8', ?, ?)", labels.feature, wsId, now, now),
    stmt(db, "INSERT INTO labels (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, '改善', '#4ea7fc', ?, ?)", labels.improvement, wsId, now, now),
    stmt(
      db,
      `INSERT INTO projects (id, workspace_id, name, description, status, lead_id, team_ids, start_date, target_date, color, icon, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'started', ?, ?, ?, ?, '#3fb27f', NULL, 1, ?, ?)`,
      projectId,
      wsId,
      "Sen をチームに導入する",
      p("チームの課題管理を Sen に移行するためのプロジェクトです。課題をこのプロジェクトに紐づけると、進捗が自動で集計されます。"),
      opts.ownerId,
      JSON.stringify([teamId]),
      cycleStart,
      addDays(cycleStart, 27),
      now,
      now,
    ),
    stmt(
      db,
      "INSERT INTO cycles (id, workspace_id, team_id, number, name, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)",
      cycle1,
      wsId,
      teamId,
      cycleStart,
      addDays(cycleStart, 13),
      now,
      now,
    ),
    stmt(
      db,
      "INSERT INTO cycles (id, workspace_id, team_id, number, name, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, 2, NULL, ?, ?, ?, ?)",
      cycle2,
      wsId,
      teamId,
      addDays(cycleStart, 14),
      addDays(cycleStart, 27),
      now,
      now,
    ),
  ];

  const issues: {
    title: string;
    desc: string;
    state: string;
    priority: number;
    labels?: string[];
    project?: boolean;
    cycle?: string;
    assign?: boolean;
    estimate?: number;
  }[] = [
    {
      title: "Sen へようこそ 👋",
      state: "未着手",
      priority: 2,
      assign: true,
      project: true,
      cycle: cycle1,
      desc:
        p("Sen は、<strong>速さ</strong>と<strong>キーボード操作</strong>を大切にした課題管理ツールです。") +
        h("3つの原則") +
        ul(
          "<strong>速く動く</strong> — 画面はすべて手元のデータから即座に描画され、変更はあとからサーバーに同期されます。",
          "<strong>キーボードで完結</strong> — ほぼすべての操作にショートカットがあります。<code>?</code> で一覧を表示できます。",
          "<strong>決まった流れで進める</strong> — バックログ → 未着手 → 進行中 → 完了 の流れに沿って、チームのリズムを作ります。",
        ) +
        p("まずは左下の「使い方動画」から、実際の操作を見てみましょう。"),
    },
    {
      title: "C キーで課題を作成してみよう",
      state: "未着手",
      priority: 3,
      assign: true,
      project: true,
      cycle: cycle1,
      labels: ["feature"],
      estimate: 1,
      desc: p("どの画面でも <code>C</code> を押すと課題作成ダイアログが開きます。タイトルを入力して <code>⌘ Enter</code>（Windows は <code>Ctrl Enter</code>）で作成できます。"),
    },
    {
      title: "⌘K でコマンドパレットを開く",
      state: "未着手",
      priority: 3,
      assign: true,
      cycle: cycle1,
      project: true,
      estimate: 1,
      desc: p("<code>⌘K</code>（<code>Ctrl K</code>）でコマンドパレットが開きます。画面の移動、課題の作成、ステータス変更など、ほとんどの操作をここから実行できます。"),
    },
    {
      title: "キーボードだけで課題を操作する",
      state: "進行中",
      priority: 2,
      assign: true,
      cycle: cycle1,
      project: true,
      labels: ["improvement"],
      estimate: 2,
      desc:
        p("一覧で <code>J</code> / <code>K</code> を押すとフォーカスが上下に移動します。フォーカス中の課題に対して：") +
        ul(
          "<code>S</code> ステータス変更",
          "<code>P</code> 優先度変更",
          "<code>A</code> 担当者変更",
          "<code>L</code> ラベル変更",
          "<code>X</code> 選択（まとめて操作）",
          "<code>Enter</code> 詳細を開く",
        ),
    },
    {
      title: "⌘B でボード表示に切り替える",
      state: "バックログ",
      priority: 4,
      labels: ["feature"],
      estimate: 1,
      desc: p("課題一覧で <code>⌘B</code> を押すと、リストとボード（カンバン）を切り替えられます。ボードではカードをドラッグしてステータスを変更できます。"),
    },
    {
      title: "プロジェクトで大きな目標を管理する",
      state: "バックログ",
      priority: 0,
      desc: p("複数の課題にまたがる目標はプロジェクトにまとめましょう。進捗率と目標日がひと目で分かります。"),
    },
    {
      title: "サイクルで1〜2週間のリズムを作る",
      state: "バックログ",
      priority: 0,
      desc: p("サイクルはスプリントのようなものです。期間内に終わらせる課題を入れておくと、残りの作業量がグラフで確認できます。"),
    },
    {
      title: "チームメンバーを招待する",
      state: "未着手",
      priority: 3,
      assign: true,
      project: true,
      cycle: cycle1,
      desc: p("設定 → メンバー から招待リンクをコピーして、チームメンバーに共有してください。"),
    },
    {
      title: "ログイン後に一瞬白い画面が表示される",
      state: "完了",
      priority: 2,
      labels: ["bug"],
      project: true,
      cycle: cycle1,
      estimate: 2,
      desc: p("サンプルのバグ報告です。完了した課題は「完了」グループにまとまります。"),
    },
  ];

  issues.forEach((it, i) => {
    const id = crypto.randomUUID();
    const t = now - (issues.length - i) * 60_000;
    const stateId = stateIds[it.state];
    const done = it.state === "完了";
    const started = it.state === "進行中" || done;
    statements.push(
      stmt(
        db,
        `INSERT INTO issues (id, workspace_id, team_id, number, title, description, state_id, priority, assignee_id, creator_id,
         project_id, cycle_id, parent_id, label_ids, subscriber_ids, estimate, due_date, sort_order, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        id,
        wsId,
        teamId,
        i + 1,
        it.title,
        it.desc,
        stateId,
        it.priority,
        it.assign ? opts.ownerId : null,
        opts.ownerId,
        it.project ? projectId : null,
        it.cycle ?? null,
        JSON.stringify((it.labels ?? []).map((k) => labels[k as keyof typeof labels])),
        JSON.stringify([opts.ownerId]),
        it.estimate ?? null,
        i,
        t,
        t,
        started ? t : null,
        done ? t : null,
      ),
      stmt(
        db,
        "INSERT INTO activities (id, workspace_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, 'created', '{}', ?)",
        crypto.randomUUID(),
        wsId,
        id,
        opts.ownerId,
        t,
      ),
    );
  });
  statements.push(stmt(db, "UPDATE teams SET issue_count = ? WHERE id = ?", issues.length, teamId));
  await batch(db, statements);
  return { id: wsId, urlKey };
}

// ---------------------------------------------------------------------------
// デモ用の豊富なデータ（ローカル開発・動画収録・ブラウザ内デモで使用）
// ---------------------------------------------------------------------------

const TEAMMATES = [
  { name: "佐藤 花子", email: "hanako@example.com", color: "#e255a1" },
  { name: "鈴木 一郎", email: "ichiro@example.com", color: "#26b5ce" },
  { name: "高橋 美咲", email: "misaki@example.com", color: "#e98a3b" },
  { name: "田中 健太", email: "kenta@example.com", color: "#3fb27f" },
  { name: "伊藤 さくら", email: "sakura@example.com", color: "#a76be8" },
];

type DemoIssue = {
  t: string; // title
  s: string; // state name
  p: number; // priority
  a?: number; // assignee index (0 = owner, 1.. = teammates)
  l?: string[];
  pr?: string;
  c?: number; // cycle index (0,1 past / 2 current / 3 next)
  e?: number;
  d?: number; // due in days
  ago: number; // created days ago
  desc?: string;
  sub?: Omit<DemoIssue, "sub">[];
  comments?: [number, string, number][]; // [user index, text, hours ago]
};

const ENG_ISSUES: DemoIssue[] = [
  {
    t: "iOS でプッシュ通知が届かないことがある",
    s: "進行中",
    p: 1,
    a: 0,
    l: ["bug"],
    pr: "mobile",
    c: 2,
    e: 3,
    d: 2,
    ago: 4,
    desc:
      p("iOS 18 以降の端末で、アプリがバックグラウンドにあるとプッシュ通知が届かない報告が複数件あります。") +
      h("再現手順") +
      ul("iOS 18.2 の端末でログインする", "アプリをバックグラウンドにする", "別端末からメッセージを送る") +
      h("期待する動作") +
      p("数秒以内に通知が表示されること。"),
    comments: [
      [1, "APNs のログを確認したところ、トークンの更新が反映されていないようです。", 30],
      [0, "ありがとうございます。トークン更新時の処理を見直します。", 26],
      [3, "Android 側では再現しませんでした。", 5],
    ],
  },
  {
    t: "決済画面で二重送信が発生する",
    s: "レビュー中",
    p: 1,
    a: 2,
    l: ["bug"],
    pr: "payment",
    c: 2,
    e: 2,
    ago: 6,
    comments: [[2, "ボタンの連打を防ぐ処理と、サーバー側の冪等キーを追加しました。レビューお願いします。", 8]],
  },
  {
    t: "検索結果のページネーションを実装する",
    s: "進行中",
    p: 2,
    a: 4,
    l: ["feature"],
    pr: "mobile",
    c: 2,
    e: 3,
    ago: 9,
    sub: [
      { t: "API にカーソル型ページングを追加", s: "完了", p: 2, a: 4, c: 2, e: 2, ago: 8 },
      { t: "無限スクロールのコンポーネントを作成", s: "進行中", p: 2, a: 4, c: 2, e: 2, ago: 8 },
      { t: "読み込み中のスケルトン表示", s: "未着手", p: 3, a: 5, c: 2, e: 1, ago: 8 },
    ],
  },
  { t: "ダークモードで一部の文字が読みにくい", s: "未着手", p: 3, a: 3, l: ["design", "improvement"], pr: "mobile", c: 2, e: 1, ago: 3 },
  {
    t: "オンボーディングの離脱率を計測する",
    s: "未着手",
    p: 2,
    a: 0,
    l: ["feature"],
    pr: "onboarding",
    c: 2,
    e: 2,
    d: 5,
    ago: 5,
    comments: [[3, "@山田 太郎 計測イベントの一覧をドキュメントにまとめておきました。確認お願いします！", 3]],
  },
  { t: "クーポンコード入力欄を追加する", s: "未着手", p: 3, a: 2, l: ["feature"], pr: "payment", c: 2, e: 3, ago: 7 },
  { t: "画像アップロードのサイズ上限を 20MB に引き上げる", s: "完了", p: 3, a: 1, l: ["improvement"], c: 2, e: 1, ago: 10 },
  { t: "ログイン画面のバリデーションメッセージを改善", s: "完了", p: 3, a: 0, l: ["improvement"], pr: "onboarding", c: 2, e: 1, ago: 11 },
  { t: "初回起動時のチュートリアルを作り直す", s: "進行中", p: 2, a: 3, l: ["design", "feature"], pr: "onboarding", c: 2, e: 5, ago: 12 },
  { t: "API のレスポンスタイムを監視するダッシュボード", s: "未着手", p: 3, a: 1, l: ["performance"], pr: "perf", c: 3, e: 3, ago: 2 },
  { t: "注文履歴の CSV エクスポート", s: "未着手", p: 4, a: 2, l: ["feature"], c: 3, e: 2, ago: 6 },
  { t: "パスワードリセットのメールが迷惑メールに入る", s: "未着手", p: 2, a: 1, l: ["bug"], c: 3, e: 2, ago: 1 },
  { t: "ホーム画面の初回表示を 1 秒以内にする", s: "バックログ", p: 2, l: ["performance"], pr: "perf", e: 5, ago: 14 },
  { t: "画像の遅延読み込みを導入する", s: "バックログ", p: 3, l: ["performance"], pr: "perf", e: 2, ago: 15 },
  { t: "依存パッケージの定期アップデート", s: "バックログ", p: 4, l: ["security"], e: 1, ago: 20 },
  { t: "アクセシビリティ監査の指摘事項に対応", s: "バックログ", p: 3, l: ["improvement"], e: 3, ago: 18 },
  { t: "決済プロバイダーの API を v3 に移行", s: "未着手", p: 2, a: 2, l: ["feature"], pr: "payment", c: 3, e: 8, d: 21, ago: 9 },
  { t: "領収書 PDF のレイアウト崩れ", s: "バックログ", p: 3, l: ["bug"], pr: "payment", e: 1, ago: 13 },
  { t: "ウィジェット機能の技術調査", s: "バックログ", p: 0, a: 4, l: ["feature"], pr: "mobile", ago: 22 },
  { t: "エラー監視のアラート条件を見直す", s: "完了", p: 3, a: 1, l: ["improvement"], c: 1, e: 1, ago: 17 },
  { t: "Android 15 の対応", s: "完了", p: 2, a: 4, l: ["feature"], pr: "mobile", c: 1, e: 5, ago: 25 },
  { t: "会員登録フォームの入力項目を減らす", s: "完了", p: 2, a: 3, l: ["improvement"], pr: "onboarding", c: 1, e: 3, ago: 24 },
  { t: "セッション切れ時にデータが消える", s: "完了", p: 1, a: 0, l: ["bug"], c: 1, e: 2, ago: 23 },
  { t: "古い決済画面のコードを削除", s: "キャンセル", p: 4, a: 2, pr: "payment", c: 1, ago: 26 },
  { t: "通知設定画面のリニューアル", s: "完了", p: 3, a: 5, l: ["design"], pr: "mobile", c: 0, e: 3, ago: 34 },
  { t: "多言語対応の文字列を整理", s: "完了", p: 4, a: 1, l: ["docs"], c: 0, e: 2, ago: 33 },
  { t: "CI のビルド時間を半分にする", s: "完了", p: 3, a: 1, l: ["performance"], pr: "perf", c: 0, e: 3, ago: 35 },
  { t: "README に開発環境の構築手順を書く", s: "未着手", p: 4, a: 0, l: ["docs"], c: 2, e: 1, ago: 2 },
  { t: "お気に入り機能の API 設計", s: "バックログ", p: 3, l: ["feature"], pr: "mobile", e: 2, ago: 4 },
  { t: "ログに個人情報が出力されていないか確認", s: "未着手", p: 1, a: 1, l: ["security"], c: 2, e: 1, d: 1, ago: 1 },
];

const DES_ISSUES: DemoIssue[] = [
  { t: "デザイントークンを Figma と同期する", s: "進行中", p: 2, a: 5, l: ["design"], pr: "ds", e: 3, ago: 6 },
  { t: "ボタンコンポーネントのバリエーション整理", s: "レビュー中", p: 3, a: 3, l: ["design"], pr: "ds", e: 2, ago: 8 },
  { t: "アイコンセットを 24px グリッドに統一", s: "未着手", p: 3, a: 5, l: ["design"], pr: "ds", e: 2, ago: 5 },
  { t: "空状態のイラストを作成", s: "未着手", p: 4, a: 3, l: ["design"], pr: "onboarding", e: 2, ago: 4 },
  { t: "カラーパレットのコントラスト比を検証", s: "完了", p: 2, a: 5, l: ["design", "improvement"], pr: "ds", e: 1, ago: 12 },
  { t: "決済完了画面のモーション案", s: "バックログ", p: 0, l: ["design"], pr: "payment", ago: 9 },
  { t: "ダークモード用のシャドウを定義", s: "バックログ", p: 3, l: ["design"], pr: "ds", e: 1, ago: 10 },
];

/** 既存ワークスペースにデモ用メンバー・チーム・課題をまとめて追加する */
export async function seedDemo(db: Db, wsId: string, ownerId: string): Promise<void> {
  const now = Date.now();
  const st: D1PreparedStatement[] = [];
  const pw = await hashPassword(randomToken());

  // メンバー
  const userIds = [ownerId];
  for (const m of TEAMMATES) {
    const existing = await first<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", m.email);
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      st.push(
        stmt(
          db,
          "INSERT INTO users (id, email, name, password_hash, avatar_color, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)",
          id,
          m.email,
          m.name,
          pw,
          m.color,
          now - 60 * DAY,
          now,
        ),
      );
    }
    st.push(
      stmt(db, "INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", wsId, id, now - 60 * DAY),
    );
    userIds.push(id);
  }
  await batch(db, st.splice(0));

  // 既存のサンプルを片付ける
  await batch(db, [
    stmt(db, "DELETE FROM issues WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM activities WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM comments WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM notifications WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM projects WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM cycles WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM labels WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM workflow_states WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM teams WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM sync_log WHERE workspace_id = ?", wsId),
    stmt(db, "DELETE FROM sync_meta WHERE workspace_id = ?", wsId),
  ]);

  const eng = crypto.randomUUID();
  const des = crypto.randomUUID();
  const engStates = (await insertTeam(db, wsId, { id: eng, name: "エンジニアリング", key: "ENG", color: "#6470e8" }, now - 60 * DAY)).stateIds;
  const desStates = (await insertTeam(db, wsId, { id: des, name: "デザイン", key: "DES", color: "#e255a1" }, now - 60 * DAY + 1000)).stateIds;

  const labels: Record<string, string> = {};
  const labelDefs: [string, string, string][] = [
    ["bug", "バグ", "#eb5757"],
    ["feature", "機能", "#a76be8"],
    ["improvement", "改善", "#4ea7fc"],
    ["design", "デザイン", "#e255a1"],
    ["performance", "パフォーマンス", "#f0bf37"],
    ["docs", "ドキュメント", "#26b5ce"],
    ["security", "セキュリティ", "#e98a3b"],
  ];
  for (const [k, name, color] of labelDefs) {
    labels[k] = crypto.randomUUID();
    st.push(
      stmt(db, "INSERT INTO labels (id, workspace_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", labels[k], wsId, name, color, now, now),
    );
  }

  const today = todayYmd();
  const projects: Record<string, string> = {};
  const projectDefs: [string, string, string, string, number | null, string, number, number, string[]][] = [
    // key, name, status, color, lead, description, startOffset, targetOffset, teams
    ["mobile", "モバイルアプリ v2.0", "started", "#4ea7fc", 1, "検索・通知・ウィジェットを刷新するメジャーアップデート。", -30, 24, [eng]],
    ["payment", "決済基盤の刷新", "started", "#3fb27f", 2, "決済プロバイダーの API v3 への移行と、二重決済の根絶。", -20, 45, [eng]],
    ["onboarding", "オンボーディング体験の改善", "started", "#e98a3b", 3, "登録から最初の価値体験までを 3 分以内にする。", -25, 10, [eng, des]],
    ["perf", "パフォーマンス改善 Q4", "planned", "#f0bf37", 1, "主要画面の表示速度を 2 倍にする。", 7, 60, [eng]],
    ["ds", "デザインシステム 2026", "started", "#e255a1", 5, "トークン・コンポーネント・ガイドラインを統合する。", -40, 30, [des]],
  ];
  projectDefs.forEach(([k, name, status, color, lead, desc, so, to, teams], i) => {
    projects[k] = crypto.randomUUID();
    st.push(
      stmt(
        db,
        `INSERT INTO projects (id, workspace_id, name, description, status, lead_id, team_ids, start_date, target_date, color, icon, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        projects[k],
        wsId,
        name,
        p(desc),
        status,
        lead === null ? null : userIds[lead],
        JSON.stringify(teams),
        addDays(today, so),
        addDays(today, to),
        color,
        i,
        now - 40 * DAY,
        now,
      ),
    );
  });

  // サイクル（過去2・現在・次回）
  const curStart = addDays(mondayOf(today), -7);
  const cycleIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = crypto.randomUUID();
    cycleIds.push(id);
    const start = addDays(curStart, (i - 2) * 14);
    st.push(
      stmt(
        db,
        "INSERT INTO cycles (id, workspace_id, team_id, number, name, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)",
        id,
        wsId,
        eng,
        i + 1,
        start,
        addDays(start, 13),
        now,
        now,
      ),
    );
  }
  await batch(db, st.splice(0));

  const notifyOwner: { issueId: string; actor: string; type: string; data: Record<string, unknown>; at: number }[] = [];

  const insertIssues = (teamId: string, stateIds: Record<string, string>, list: DemoIssue[]) => {
    let number = 0;
    const walk = (it: DemoIssue | Omit<DemoIssue, "sub">, parentId: string | null, order: number) => {
      number++;
      const id = crypto.randomUUID();
      const created = now - it.ago * DAY - (order % 7) * 3_600_000;
      const stName = it.s;
      const started = ["進行中", "レビュー中", "完了"].includes(stName);
      const done = stName === "完了";
      const canceled = stName === "キャンセル";
      const assignee = it.a !== undefined ? userIds[it.a] : null;
      const creator = userIds[(order + 1) % userIds.length];
      const doneAt = done ? Math.min(now - 3_600_000, created + Math.max(1, it.ago - 1) * DAY * 0.7) : null;
      const subs = [...new Set([creator, assignee].filter(Boolean))] as string[];
      st.push(
        stmt(
          db,
          `INSERT INTO issues (id, workspace_id, team_id, number, title, description, state_id, priority, assignee_id, creator_id,
           project_id, cycle_id, parent_id, label_ids, subscriber_ids, estimate, due_date, sort_order, created_at, updated_at,
           started_at, completed_at, canceled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          wsId,
          teamId,
          number,
          it.t,
          it.desc ?? "",
          stateIds[stName],
          it.p,
          assignee,
          creator,
          it.pr ? projects[it.pr] : null,
          it.c !== undefined && teamId === eng ? cycleIds[it.c] : null,
          parentId,
          JSON.stringify((it.l ?? []).map((k) => labels[k])),
          JSON.stringify(subs),
          it.e ?? null,
          it.d !== undefined ? addDays(today, it.d) : null,
          order,
          created,
          doneAt ?? created + 3_600_000,
          started ? created + 2 * 3_600_000 : null,
          doneAt,
          canceled ? created + DAY : null,
        ),
        stmt(
          db,
          "INSERT INTO activities (id, workspace_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, 'created', '{}', ?)",
          crypto.randomUUID(),
          wsId,
          id,
          creator,
          created,
        ),
      );
      if (assignee) {
        st.push(
          stmt(
            db,
            "INSERT INTO activities (id, workspace_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, 'assignee', ?, ?)",
            crypto.randomUUID(),
            wsId,
            id,
            creator,
            JSON.stringify({ from: null, to: assignee }),
            created + 60_000,
          ),
        );
        if (assignee === ownerId && creator !== ownerId && it.ago < 8) {
          notifyOwner.push({ issueId: id, actor: creator, type: "assigned", data: {}, at: created + 60_000 });
        }
      }
      if (started) {
        const toState = done ? stateIds["完了"] : stateIds[stName];
        st.push(
          stmt(
            db,
            "INSERT INTO activities (id, workspace_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, 'state', ?, ?)",
            crypto.randomUUID(),
            wsId,
            id,
            assignee ?? creator,
            JSON.stringify({ from: stateIds["未着手"], to: done ? stateIds["進行中"] : toState }),
            created + 2 * 3_600_000,
          ),
        );
        if (done && doneAt) {
          st.push(
            stmt(
              db,
              "INSERT INTO activities (id, workspace_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, 'state', ?, ?)",
              crypto.randomUUID(),
              wsId,
              id,
              assignee ?? creator,
              JSON.stringify({ from: stateIds["進行中"], to: toState }),
              doneAt,
            ),
          );
        }
      }
      for (const [ui, text, hoursAgo] of it.comments ?? []) {
        const cid = crypto.randomUUID();
        const at = now - hoursAgo * 3_600_000;
        st.push(
          stmt(
            db,
            "INSERT INTO comments (id, workspace_id, issue_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            cid,
            wsId,
            id,
            userIds[ui],
            p(text),
            at,
            at,
          ),
        );
        if (userIds[ui] !== ownerId && (assignee === ownerId || creator === ownerId || text.includes("@山田"))) {
          notifyOwner.push({
            issueId: id,
            actor: userIds[ui],
            type: text.includes("@") ? "mention" : "comment",
            data: { commentId: cid, snippet: text.slice(0, 140) },
            at,
          });
        }
      }
      if ("sub" in it && it.sub) it.sub.forEach((s, j) => walk(s, id, order * 10 + j));
    };
    list.forEach((it, i) => walk(it, null, i));
    st.push(stmt(db, "UPDATE teams SET issue_count = ? WHERE id = ?", number, teamId));
  };
  insertIssues(eng, engStates, ENG_ISSUES);
  insertIssues(des, desStates, DES_ISSUES);

  for (const n of notifyOwner) {
    st.push(
      stmt(
        db,
        "INSERT INTO notifications (id, workspace_id, user_id, issue_id, actor_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        wsId,
        ownerId,
        n.issueId,
        n.actor,
        n.type,
        JSON.stringify(n.data),
        n.at,
      ),
    );
  }
  await batch(db, st);
}
