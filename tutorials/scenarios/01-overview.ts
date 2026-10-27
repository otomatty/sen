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
    await t.caption("はじめてログインすると、Sen の考え方が表示されます");
    // この字幕は「いま見えている画面」の説明なので、読み終わるまで待ってから閉じる
    await t.settle();
    await t.wait(600);
    await t.click("[data-testid=welcome-start]");
    await t.expect("[data-testid=welcome-modal]", { hidden: true });
    await t.caption("左のサイドバーが、すべての画面への入り口です");
    await t.highlight("[data-testid=sidebar] .sidebar-nav", 1500);
    await t.poster();
    await t.caption("受信トレイには、あなた宛ての通知が届きます");
    await t.click("[data-testid=nav-inbox]");
    await t.expect("[data-testid=inbox-page]");
    await t.caption("「自分の課題」には、担当している課題がまとまります");
    await t.click("[data-testid=nav-my-issues]");
    await t.expectUrl(/\/my-issues/);
    await t.caption("チームごとの課題一覧は、チーム名の下にあります");
    await t.click("[data-testid=nav-team-ENG-issues]");
    await t.expectUrl(/\/team\/ENG/);
    await t.park();
    await t.caption("キーボードでも移動できます。G → I で受信トレイへ");
    await t.press("g i", { pause: 700 });
    await t.expect("[data-testid=inbox-page]");
    await t.caption("G → M で「自分の課題」へ戻ります");
    await t.press("g m", { pause: 700 });
    await t.expectUrl(/\/my-issues/);
    await t.caption("? を押すと、ショートカットの一覧が開きます");
    await t.press("?", { label: ["?"], pause: 300 });
    await t.expect("[data-testid=shortcuts-help]");
    await t.wait(1300);
    await t.press("Escape", { show: false, pause: 300 });
    await t.caption("⌘K（Ctrl+K）のパレットから、ほぼすべての操作ができます");
    await t.press("Meta+k", { pause: 300 });
    await t.expect("[data-testid=command-palette]");
    await t.wait(1200);
    await t.press("Escape", { show: false, pause: 300 });
    await t.caption("使い方動画は、サイドバーの下からいつでも見られます");
    await t.highlight("[data-testid=nav-help]", 1600);
  },
});
