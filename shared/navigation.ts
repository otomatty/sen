// 画面とコマンドの一覧。コマンドパレット、移動のショートカット、ショートカット一覧の「移動」がここを参照する。
// React や DOM には依存しない（Worker や Node からも import できる）。

export interface ScreenDef {
  id: string; // 例: "inbox"
  title: string; // 画面の名前（例: "受信トレイ"）
  description: string; // 利用者向けの 1〜2 文の説明（です・ます調、日本語）
  path: string; // ワークスペースの中のパス。チームの画面はチームの識別子を ":team"、チームの ID を ":teamId" で書く
  where: string; // 開き方の説明（例: "サイドバーの「受信トレイ」"）
  combo?: string; // 移動のショートカット（例: "g i"）
  shortcutLabel?: string; // ショートカット一覧での表示名（title と違うときだけ）
}

export const SCREENS = [
  {
    id: "inbox",
    title: "受信トレイ",
    description:
      "自分宛ての通知を、課題ごとにまとめて確認する画面です。課題の担当者になったとき、コメントでメンションされたとき、購読中の課題にコメントがついたとき、購読中の課題のステータスが変わったときに届きます。",
    path: "/inbox",
    where: "サイドバーの「受信トレイ」",
    combo: "g i",
  },
  {
    id: "my-issues",
    title: "自分の課題",
    description: "自分が担当している課題の一覧です。「作成」「購読中」のタブで、作った課題と購読している課題も見られます。",
    path: "/my-issues",
    where: "サイドバーの「自分の課題」",
    combo: "g m",
  },
  {
    id: "my-issues-created",
    title: "作成した課題",
    description: "自分が作成した課題の一覧です。",
    path: "/my-issues/created",
    where: "自分の課題の「作成」タブ",
  },
  {
    id: "my-issues-subscribed",
    title: "購読中の課題",
    description: "通知を購読している課題の一覧です。",
    path: "/my-issues/subscribed",
    where: "自分の課題の「購読中」タブ",
  },
  {
    id: "team-all",
    title: "チームのすべての課題",
    description: "チームの課題を、ステータスを問わず一覧する画面です。",
    path: "/team/:team/all",
    where: "サイドバーでチームを開き、「課題」を選ぶ",
    combo: "g e",
  },
  {
    id: "team-active",
    title: "チームのアクティブな課題",
    description:
      "チームの「アクティブ」タブです。種類が未着手と進行中の課題を一覧します。レビュー中は進行中の種類なので、ここにも入ります。",
    path: "/team/:team/active",
    where: "チームの課題画面の「アクティブ」タブ",
    combo: "g a",
  },
  {
    id: "team-backlog",
    title: "チームのバックログ",
    description: "チームのバックログにある課題を一覧する画面です。",
    path: "/team/:team/backlog",
    where: "チームの課題画面の「バックログ」タブ",
    combo: "g b",
  },
  {
    id: "team-cycles",
    title: "サイクル",
    description:
      "チームのサイクル（期間ごとの計画）を一覧する画面です。現在のサイクル、今後のサイクル、過去のサイクルと、それぞれの進み具合を確認できます。",
    path: "/team/:team/cycles",
    where: "サイドバーでチームを開き、「サイクル」を選ぶ",
    combo: "g c",
  },
  {
    id: "team-projects",
    title: "チームのプロジェクト",
    description:
      "そのチームに紐づくプロジェクトを、進行中・計画中・完了のタブに分けて一覧する画面です。進行中には一時停止、計画中にはバックログ、完了にはキャンセルも入ります。開いているタブの中で、行をドラッグして表示順を並び替えられます。",
    path: "/team/:team/projects",
    where: "サイドバーでチームを開き、「プロジェクト」を選ぶ",
  },
  {
    id: "projects",
    title: "プロジェクト",
    description:
      "ワークスペースのプロジェクトを、進行中・計画中・完了のタブに分けて一覧する画面です。進行中には一時停止、計画中にはバックログ、完了にはキャンセルも入ります。開いているタブの中で、行をドラッグして表示順を並び替えられます。",
    path: "/projects",
    where: "サイドバーの「プロジェクト」",
    combo: "g p",
  },
  {
    id: "progress",
    title: "進捗",
    description: "進捗の「活動一覧」です。プロジェクトごとの完了率、直近期限、活動状況を確認します。数え方はスプレッドシート連携と同じです。",
    path: "/progress",
    where: "サイドバーの「進捗」",
    combo: "g r",
  },
  {
    id: "progress-wbs",
    title: "WBS",
    description: "進捗の「WBS」タブです。活動ごとの作業を、担当・期限・状態つきで見ます。",
    path: "/progress/wbs",
    where: "進捗画面の「WBS」タブ",
  },
  {
    id: "progress-timeline",
    title: "タイムライン",
    description: "進捗の「タイムライン」タブです。活動と作業を、週・月・四半期の時間軸で見ます。",
    path: "/progress/timeline",
    where: "進捗画面の「タイムライン」タブ",
  },
  {
    id: "search",
    title: "検索",
    description: "課題のタイトル、説明、ID から検索する画面です。入力すると、その場で結果が絞られます。",
    path: "/search",
    where: "サイドバー上部の検索ボタン",
    combo: "/",
  },
  {
    id: "settings",
    title: "設定",
    description:
      "設定の入り口です。開いた直後は「全般」が表示されます。プロフィールと表示、AI 連携、メンバー、ラベル、チーム、削除した課題、各チームの設定をここから開きます。",
    path: "/settings",
    where: "サイドバー上部のワークスペース名メニューの「設定」",
    combo: "g s",
  },
  {
    id: "settings-profile",
    title: "プロフィールと表示",
    description:
      "名前、アバターの色、テーマ（システム・ライト・ダーク）を変える画面です。メールアドレスは表示されます。参加しているワークスペースが 2 つ以上のときは、最初に開くワークスペースも選べます。アプリのインストールと、新しいバージョンへの更新もここからできます。",
    path: "/settings/profile",
    where: "設定の「プロフィールと表示」",
  },
  {
    id: "settings-ai",
    title: "AI 連携",
    description: "Claude Code や Cursor などから Sen を操作するための接続トークンを発行する画面です。できることと有効期限を選べます。",
    path: "/settings/ai",
    where: "設定の「AI 連携」",
  },
  {
    id: "settings-workspace",
    title: "全般",
    description:
      "ワークスペースの名前と URL を見る画面です。URL は表示されるだけで、変更できません。名前を変えられるのは管理者だけです。メンバーの招待と、利用できるドメインの設定は「メンバー」にあります。「メンバーの設定」からメンバーの画面を開けます。設定されていれば、スプレッドシート連携の区画もこの画面にあります。",
    path: "/settings/workspace",
    where: "設定の「全般」",
  },
  {
    id: "settings-members",
    title: "メンバー",
    description:
      "メンバーの一覧を見る画面です。管理者だけが、メールアドレスを指定して招待し、権限の変更とメンバーを外すことができます。招待した直後に、その人だけの参加リンクが出ます。利用できるドメインも、管理者だけが設定できます。",
    path: "/settings/members",
    where: "設定の「メンバー」。ワークスペース名メニューの「メンバーを招待」と、全般の「メンバーの設定」からも開けます",
  },
  {
    id: "settings-labels",
    title: "ラベル",
    description: "課題の分類に使うラベルを追加・編集する画面です。ラベルはワークスペース全体で共通です。",
    path: "/settings/labels",
    where: "設定の「ラベル」",
  },
  {
    id: "settings-teams",
    title: "チーム",
    description: "チームの一覧と、新しいチームの作成を行う画面です。チームごとに課題、ワークフロー、サイクルを持てます。",
    path: "/settings/teams",
    where: "設定の「チーム」",
  },
  {
    id: "settings-trash",
    title: "削除した課題",
    description: "削除した課題を確認し、元に戻す画面です。",
    path: "/settings/trash",
    where: "設定の「削除した課題」",
  },
  {
    id: "settings-team",
    title: "チームの設定",
    description: "チームの名前、識別子、色を変える画面です。サイクルを使うかどうかとその期間、ワークフロー（ステータス）もここで変えます。",
    path: "/settings/team/:teamId",
    where: "設定の「チームの設定」からチームを選ぶ",
  },
  {
    id: "help",
    title: "使い方動画",
    description: "各画面の操作を短い動画で見る画面です。キーボードショートカットの一覧も下に並びます。",
    path: "/help",
    where: "サイドバーの「使い方動画」",
    combo: "g h",
  },
] as const satisfies readonly ScreenDef[];

export type ScreenId = (typeof SCREENS)[number]["id"];

type ScreenConst = (typeof SCREENS)[number];
type ScreenWithCombo = Extract<ScreenConst, { combo: string }>;

const SCREEN_ID_LIST: readonly string[] = SCREENS.map((s) => s.id);

export function isScreenId(v: unknown): v is ScreenId {
  return typeof v === "string" && SCREEN_ID_LIST.includes(v);
}

/**
 * 画面の path と実際の URL がずれるもの。画面定義そのものより短いときだけ使い、
 * 同じ URL により長い path が合う画面があればそちらを優先する。
 * - /my-issues は assigned へリダイレクトされる。担当タブが「自分の課題」
 * - タブ無しの /team/:team は、画面の既定タブ（すべての課題）
 */
const SCREEN_PATH_ALIASES: { id: ScreenId; path: string }[] = [
  { id: "my-issues", path: "/my-issues/assigned" },
  { id: "team-all", path: "/team/:team" },
];

/** `:team` と `:teamId` は名前の全体で置き換える（`:team` が `:teamId` の先頭に食い込まない） */
function fillPath(path: string, ctx: { teamKey?: string; teamId?: string }): string | null {
  let missing = false;
  const filled = path.replace(/:([A-Za-z]+)/g, (whole, name: string) => {
    if (name === "teamId") {
      if (!ctx.teamId) missing = true;
      return ctx.teamId ?? whole;
    }
    if (name === "team") {
      if (!ctx.teamKey) missing = true;
      return ctx.teamKey ?? whole;
    }
    missing = true;
    return whole;
  });
  return missing ? null : filled;
}

export function resolveScreenPath(screen: ScreenId, ctx: { ws: string; teamKey?: string; teamId?: string }): string | null {
  const def = SCREENS.find((s) => s.id === screen);
  if (!def) return null;
  const path = fillPath(def.path, ctx);
  if (path == null) return null;
  return `/${ctx.ws}${path}`;
}

function pathWithinWorkspace(pathname: string): string | null {
  const pathOnly = pathname.split("?")[0]?.split("#")[0] ?? "";
  const parts = pathOnly.split("/").filter(Boolean);
  // 先頭はワークスペースの識別子。画面の path はそれ以降
  if (parts.length < 2) return null;
  return `/${parts.slice(1).join("/")}`;
}

function patternMatches(pattern: string, rest: string): boolean {
  const expected = pattern.split("/").filter(Boolean);
  const actual = rest.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith(":")) continue;
    if (expected[i] !== actual[i]) return false;
  }
  return true;
}

/** いま開いている URL に、いちばん長く一致する画面の id。一覧に無い画面は null */
export function screenForPath(pathname: string): ScreenId | null {
  const rest = pathWithinWorkspace(pathname);
  if (rest == null) return null;
  let bestId: ScreenId | null = null;
  let bestLen = -1;
  const consider = (id: ScreenId, pattern: string) => {
    if (!patternMatches(pattern, rest)) return;
    const len = pattern.split("/").filter(Boolean).length;
    if (len > bestLen) {
      bestId = id;
      bestLen = len;
    }
  };
  for (const screen of SCREENS) consider(screen.id, screen.path);
  for (const alias of SCREEN_PATH_ALIASES) consider(alias.id, alias.path);
  return bestId;
}

/** combo を持つ画面。配列は固定（SCREENS の並び）なので、フックの呼び出し順は変わらない */
export const NAVIGATION_SHORTCUT_SCREENS: readonly ScreenWithCombo[] = SCREENS.filter(
  (s): s is ScreenWithCombo => "combo" in s,
);

/**
 * ショートカット一覧の「移動」。combo が "g " で始まる画面を、SCREENS の順に並べる。
 * この順は従来の一覧（g i, g m, g e, g a, g b, g c, g p, g r, g s, g h）と一致する。
 * 検索の「/」は「全体」グループのままなので、ここには含めない。
 */
export function navigationShortcutItems(): [string, string][] {
  const items: [string, string][] = [];
  for (const raw of SCREENS) {
    const screen: ScreenDef = raw;
    if (!screen.combo?.startsWith("g ")) continue;
    items.push([screen.combo, screen.shortcutLabel ?? screen.title]);
  }
  return items;
}

export interface CommandDef {
  id: string;
  label: string; // パレットに出す名前。team: true のときは "{team}" をチーム名に置き換える
  group: "課題" | "作成" | "移動" | "ヘルプ" | "表示" | "その他";
  description: string; // 利用者向けの説明（です・ます調、日本語）
  combo?: string;
  keywords?: string;
  screen?: ScreenId; // 画面へ移動するコマンド。combo を書かず、画面の combo を使う
  team?: boolean; // チームごとに 1 つずつ並ぶコマンド（id はパレットでは `${id}-${team.id}`）
  context?: "issues" | "single-issue"; // 課題をフォーカス・選択しているときだけ出る。single-issue は 1 件のときだけ
  availability?: string; // 出る条件の説明（例: "このブラウザでインストールできるとき"）
}

// 課題どうしの関係（ブロックなど）は Relations.tsx の RELATION_ACTIONS のまま。パレットでは parent の直後に出す。
// team: true の keywords にある "{key}" は、パレットでチームの識別子に置き換える。
export const COMMANDS = [
  {
    id: "status",
    label: "ステータスを変更…",
    group: "課題",
    description: "選択している課題のステータスを変更します。",
    combo: "s",
    keywords: "status",
    context: "issues",
  },
  {
    id: "priority",
    label: "優先度を設定…",
    group: "課題",
    description: "選択している課題の優先度を設定します。",
    combo: "p",
    keywords: "priority",
    context: "issues",
  },
  {
    id: "assignee",
    label: "担当者を変更…",
    group: "課題",
    description: "選択している課題の担当者を変更します。",
    combo: "a",
    keywords: "assign",
    context: "issues",
  },
  {
    id: "assign-me",
    label: "自分に割り当てる",
    group: "課題",
    description: "選択している課題の担当者を自分にします。",
    combo: "i",
    context: "issues",
  },
  {
    id: "labels",
    label: "ラベルを変更…",
    group: "課題",
    description: "選択している課題のラベルを変更します。",
    combo: "l",
    keywords: "label",
    context: "issues",
  },
  {
    id: "project",
    label: "プロジェクトに追加…",
    group: "課題",
    description: "選択している課題をプロジェクトに追加します。",
    combo: "shift+p",
    keywords: "project",
    context: "issues",
  },
  {
    id: "cycle",
    label: "サイクルに追加…",
    group: "課題",
    description: "選択している課題をサイクルに追加します。",
    combo: "shift+c",
    keywords: "cycle sprint",
    context: "issues",
  },
  {
    id: "due",
    label: "期日を設定…",
    group: "課題",
    description: "選択している課題の期日を設定します。",
    combo: "shift+d",
    keywords: "due date",
    context: "issues",
  },
  {
    id: "estimate",
    label: "見積もりを設定…",
    group: "課題",
    description: "選択している課題の見積もり（ポイント）を設定します。",
    combo: "shift+e",
    keywords: "estimate point",
    context: "issues",
  },
  {
    id: "parent",
    label: "親課題を設定…",
    group: "課題",
    description: "選択している課題の親課題を設定します。",
    keywords: "parent",
    context: "issues",
  },
  {
    id: "team",
    label: "別のチームに移動…",
    group: "課題",
    description: "選択している課題を別のチームへ移します。",
    keywords: "move team",
    context: "issues",
  },
  {
    id: "copy-id",
    label: "ID をコピー",
    group: "課題",
    description: "課題の ID（例：DEF-12）をコピーします。",
    combo: "mod+.",
    context: "single-issue",
  },
  {
    id: "copy-link",
    label: "リンクをコピー",
    group: "課題",
    description: "課題を開くリンクをコピーします。",
    context: "single-issue",
  },
  {
    id: "copy-branch",
    label: "Git ブランチ名をコピー",
    group: "課題",
    description: "課題の Git ブランチ名をコピーします。",
    combo: "mod+shift+.",
    keywords: "git branch",
    context: "single-issue",
  },
  {
    id: "subscribe",
    label: "通知の購読を切り替え",
    group: "課題",
    description: "この課題の通知の購読を切り替えます。",
    context: "single-issue",
  },
  {
    id: "delete",
    label: "削除",
    group: "課題",
    description: "選択している課題を削除します。削除した課題は「削除した課題」から元に戻せます。",
    combo: "mod+backspace",
    keywords: "delete archive",
    context: "issues",
  },
  {
    id: "new-issue",
    label: "新しい課題を作成",
    group: "作成",
    description: "新しい課題の作成画面を開きます。",
    combo: "c",
    keywords: "create new issue",
  },
  {
    id: "new-project",
    label: "新しいプロジェクトを作成",
    group: "作成",
    description: "プロジェクトの一覧を開き、新しいプロジェクトの作成画面を出します。",
    keywords: "create project",
  },
  {
    id: "new-cycle",
    label: "{team} に新しいサイクルを作成",
    group: "作成",
    description: "そのチームに新しいサイクルを作成し、サイクルの画面を開きます。",
    keywords: "create cycle sprint",
    team: true,
  },
  {
    id: "go-inbox",
    label: "受信トレイへ移動",
    group: "移動",
    description: "受信トレイへ移動します。",
    keywords: "inbox",
    screen: "inbox",
  },
  {
    id: "go-my",
    label: "自分の課題へ移動",
    group: "移動",
    description: "自分の課題へ移動します。",
    keywords: "my issues",
    screen: "my-issues",
  },
  {
    id: "go-projects",
    label: "プロジェクトへ移動",
    group: "移動",
    description: "プロジェクトへ移動します。",
    keywords: "projects",
    screen: "projects",
  },
  {
    id: "go-progress",
    label: "進捗へ移動",
    group: "移動",
    description: "進捗へ移動します。",
    keywords: "progress wbs 進捗 活動",
    screen: "progress",
  },
  // go-team / go-backlog / go-cycles は隣り合う。パレットはチームごとにこの順で出す。
  {
    id: "go-team",
    label: "{team} の課題へ移動",
    group: "移動",
    description: "そのチームのすべての課題へ移動します。",
    keywords: "{key} issues team",
    screen: "team-all",
    team: true,
  },
  {
    id: "go-backlog",
    label: "{team} のバックログへ移動",
    group: "移動",
    description: "そのチームのバックログへ移動します。",
    keywords: "{key} backlog",
    screen: "team-backlog",
    team: true,
  },
  {
    id: "go-cycles",
    label: "{team} のサイクルへ移動",
    group: "移動",
    description: "そのチームのサイクルへ移動します。",
    keywords: "{key} cycles",
    screen: "team-cycles",
    team: true,
  },
  {
    id: "go-search",
    label: "検索",
    group: "移動",
    description: "検索画面を開きます。",
    keywords: "search find",
    screen: "search",
  },
  {
    id: "go-settings",
    label: "設定を開く",
    group: "移動",
    description: "設定を開きます。",
    keywords: "settings",
    screen: "settings",
  },
  {
    id: "go-help",
    label: "使い方動画を見る",
    group: "ヘルプ",
    description: "使い方動画を開きます。",
    keywords: "help tutorial video",
    screen: "help",
  },
  {
    id: "open-assistant",
    label: "AI アシスタントを開く",
    group: "ヘルプ",
    description: "Sen の使い方を質問する AI アシスタントを開きます。課題などの内容は送りません。",
    keywords: "ai assistant chat 質問",
    availability: "AI アシスタントが使えるとき",
  },
  {
    id: "shortcuts",
    label: "キーボードショートカット一覧",
    group: "ヘルプ",
    description: "キーボードショートカットの一覧を開きます。",
    combo: "?",
    keywords: "keyboard shortcuts",
  },
  {
    id: "toggle-layout",
    label: "リスト / ボード表示を切り替え",
    group: "表示",
    description: "課題の一覧を開いているとき、リスト表示とボード表示を切り替えます。",
    combo: "mod+b",
    keywords: "board list kanban layout",
  },
  {
    id: "theme-dark",
    label: "テーマ：ダーク",
    group: "表示",
    description: "画面のテーマをダークにします。",
    keywords: "theme dark",
  },
  {
    id: "theme-light",
    label: "テーマ：ライト",
    group: "表示",
    description: "画面のテーマをライトにします。",
    keywords: "theme light",
  },
  {
    id: "theme-system",
    label: "テーマ：システムに合わせる",
    group: "表示",
    description: "画面のテーマを、端末の設定に合わせます。",
    keywords: "theme system",
  },
  {
    id: "undo",
    label: "元に戻す",
    group: "その他",
    description: "直前の操作を元に戻します。",
    combo: "mod+z",
    keywords: "undo",
  },
  {
    id: "install-app",
    label: "アプリをインストール",
    group: "その他",
    description: "Sen をこの端末にインストールし、専用のウィンドウで開けるようにします。",
    keywords: "install app pwa",
    availability: "このブラウザでインストールできるとき",
  },
  {
    id: "update-app",
    label: "新しいバージョンに更新",
    group: "その他",
    description: "新しいバージョンに更新して、アプリを再読み込みします。",
    keywords: "update reload version",
    availability: "新しいバージョンの準備ができているとき",
  },
  {
    id: "logout",
    label: "ログアウト",
    group: "その他",
    description: "ログアウトします。",
    keywords: "logout sign out",
  },
] as const satisfies readonly CommandDef[];

export type CommandId = (typeof COMMANDS)[number]["id"];

/** パレットに出すショートカット。チームごとの行には画面の combo を出さない（g e などは今いるチーム用） */
export function commandCombo(cmd: Pick<CommandDef, "combo" | "screen" | "team">): string | undefined {
  if (cmd.combo) return cmd.combo;
  if (!cmd.screen || cmd.team) return undefined;
  const screen = SCREENS.find((s) => s.id === cmd.screen);
  if (!screen || !("combo" in screen)) return undefined;
  return screen.combo;
}

export interface CommandView {
  id: string;
  label: string;
  group: CommandDef["group"];
  combo?: string;
  keywords?: string;
}

/** パレットに出す id・ラベル・combo・keywords。チーム行は "{team}" と "{key}" を置き換える */
export function presentCommand(cmd: CommandDef, team?: { id: string; name: string; key: string }): CommandView {
  const keywords = cmd.keywords == null ? undefined : team ? cmd.keywords.replaceAll("{key}", team.key) : cmd.keywords;
  return {
    id: cmd.team && team ? `${cmd.id}-${team.id}` : cmd.id,
    label: team ? cmd.label.replaceAll("{team}", team.name) : cmd.label,
    group: cmd.group,
    combo: commandCombo(cmd),
    keywords,
  };
}
