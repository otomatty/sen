import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "overview",
  order: 1,
  screen: "overview",
  title: "Sen の全体像",
  summary: "サイドバーの構成と、どの画面でも使える基本のショートカットを紹介します。",
  start: "/my-issues",
  freshUser: true,
  async run(t) {
    await t.caption("はじめてログインすると、Sen の考え方が表示されます", { hold: 2600 });
    await t.click("[data-testid=welcome-start]");
    await t.caption("左のサイドバーが、すべての画面への入り口です");
    await t.highlight("[data-testid=sidebar] .sidebar-nav", 1500);
    await t.click("[data-testid=nav-inbox]");
    await t.caption("受信トレイ：割り当て・コメント・メンションなど、あなた宛ての通知が届きます");
    await t.click("[data-testid=nav-my-issues]");
    await t.caption("マイイシュー：自分が担当している課題がまとまります");
    await t.click("[data-testid=nav-team-ENG-issues]");
    await t.caption("チームの課題：チームごとの一覧です。サイクルやプロジェクトもチームの下にあります");
    await t.moveToPoint(120, 700);
    await t.caption("キーボードでも移動できます。G のあとに I で受信トレイへ");
    await t.press("g i", { pause: 900 });
    await t.caption("G のあとに M でマイイシューへ戻ります", { hold: 1600 });
    await t.press("g m", { pause: 900 });
    await t.caption("? を押すと、すべてのショートカットを確認できます");
    await t.press("?", { label: ["?"], pause: 1800 });
    await t.press("Escape", { show: false });
    await t.caption("⌘K（Windows は Ctrl+K）のコマンドパレットからは、ほぼすべての操作ができます");
    await t.press("Meta+k", { pause: 1600 });
    await t.press("Escape", { show: false });
    await t.caption("使い方動画は、サイドバー下と各画面の「使い方」ボタンからいつでも見られます");
    await t.highlight("[data-testid=nav-help]", 1800);
  },
});
