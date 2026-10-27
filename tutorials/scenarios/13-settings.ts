import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "settings",
  order: 13,
  screen: "settings",
  title: "設定とメンバーの招待",
  summary: "メンバーの招待、ラベルの管理、チームのワークフロー、テーマの切り替えを行います。",
  start: "/settings/workspace",
  async run(t) {
    await t.caption("設定では、ワークスペース・メンバー・ラベルなどを管理します");
    await t.poster();
    await t.settle();
    await t.click("[data-testid=settings-nav-members]");
    await t.caption("招待リンクを共有すると、メンバーが参加できます");
    await t.highlight("[data-testid=invite-link]", 1200);
    await t.click(".invite-row button:has-text('コピー')", { pause: 700 });
    await t.click("[data-testid=settings-nav-labels]");
    await t.caption("ラベルを追加してみます");
    await t.click("[data-testid=new-label-name]");
    await t.type("要調査");
    await t.click(".label-add .color-button");
    await t.click(".color-popover .color-swatch >> nth=6");
    await t.click("[data-testid=new-label-submit]", { pause: 700 });
    await t.expect("[data-testid=label-row] input[value='要調査']");
    await t.caption("追加したラベルは、課題の L キーからすぐ使えます", { hold: 1600 });
    await t.click(".settings-nav a:has-text('エンジニアリング')");
    await t.caption("チームごとに、ID の接頭辞やワークフローを設定できます");
    await t.scroll(".settings-content", 520);
    await t.click("[data-testid=settings-nav-profile]");
    await t.caption("テーマは、ライト・ダーク・システムから選べます");
    await t.click("[data-testid=theme-light]", { pause: 1500 });
    await t.click("[data-testid=theme-dark]", { pause: 900 });
  },
});
