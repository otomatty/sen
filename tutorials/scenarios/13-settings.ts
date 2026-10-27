import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "settings",
  order: 13,
  screen: "settings",
  title: "設定とメンバーの招待",
  summary: "メンバーの招待、ラベルの管理、チームのワークフロー、テーマの切り替えを行います。",
  start: "/settings/workspace",
  async run(t) {
    await t.caption("設定では、ワークスペース・メンバー・ラベル・チームを管理します");
    await t.click("[data-testid=settings-nav-members]");
    await t.caption("招待リンクをコピーして共有すると、メンバーが参加できます");
    await t.highlight("[data-testid=invite-link]", 1200);
    await t.click(".invite-row button:has-text('コピー')", { pause: 900 });
    await t.click("[data-testid=settings-nav-labels]");
    await t.caption("ラベルを追加してみます");
    await t.click("[data-testid=new-label-name]");
    await t.type("要調査");
    await t.click(".label-add .color-swatch >> nth=6");
    await t.click("[data-testid=new-label-submit]", { pause: 900 });
    await t.caption("追加したラベルは、課題の L キーからすぐに使えます", { hold: 1600 });
    await t.click(".settings-nav a:has-text('エンジニアリング')");
    await t.caption("チームごとに、課題 ID の接頭辞・サイクルの期間・ワークフローを設定できます");
    await t.scroll(".settings-content", 520);
    await t.click("[data-testid=settings-nav-profile]");
    await t.caption("テーマは、ライト・ダーク・システムに合わせる、から選べます");
    await t.click("[data-testid=theme-light]", { pause: 1600 });
    await t.click("[data-testid=theme-dark]", { pause: 1000 });
  },
});
