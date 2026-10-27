import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "create-issue",
  order: 2,
  screen: "create",
  title: "課題を作成する",
  summary: "どの画面からでも C キーで課題を作成できます。プロパティもその場で設定できます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.park();
    await t.caption("どの画面でも、C キーで課題の作成画面が開きます");
    await t.press("c");
    await t.expect("[data-testid=create-issue-modal]");
    await t.caption("まずタイトルを入力します");
    await t.type("ログイン画面にパスワード表示ボタンを追加");
    await t.press("Enter", { show: false, pause: 300 });
    await t.caption("Enter で説明欄へ。Markdown 記法が使えます");
    await t.type("入力したパスワードを確認できるよう、目のアイコンで表示を切り替える。");
    await t.caption("下のボタンで、優先度や担当者をその場で設定します");
    await t.click("[data-testid=create-priority]");
    await t.click("[data-testid=picker-priority] [role=option]:has-text('高')");
    await t.click("[data-testid=create-assignee]");
    await t.click("[data-testid=picker-assignee] [role=option]:has-text('自分')");
    await t.click("[data-testid=create-labels]");
    await t.click("[data-testid=picker-labels] [role=option]:has-text('機能')");
    await t.press("Escape", { show: false, pause: 400 });
    await t.expect("[data-testid=create-priority]", { text: "高" });
    await t.poster();
    await t.caption("⌘ + Enter（Ctrl + Enter）で作成します");
    await t.press("Meta+Enter", { pause: 600 });
    await t.expect("[data-testid=create-issue-modal]", { hidden: true });
    await t.expect("[data-testid=issue-row]:has-text('パスワード表示ボタン')");
    await t.caption("作成した課題は、すぐ一覧に加わります。保存は自動です", { hold: 2600 });
    await t.highlight("[data-testid=issue-row]:has-text('パスワード表示ボタン')", 1600);
  },
});
