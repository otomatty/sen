import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "filters",
  order: 5,
  screen: "issues",
  title: "フィルターで絞り込む",
  summary: "担当者・優先度・ラベルなどの条件で一覧を絞り込みます。条件は画面ごとに保存されます。",
  start: "/team/ENG/all",
  async run(t) {
    await t.caption("フィルターで、表示する課題を絞り込みます");
    await t.click("[data-testid=filter-button]");
    await t.click(".menu-item:has-text('担当者')");
    await t.click("[data-testid=filter-picker-assignee] [role=option]:has-text('自分')", { pause: 600 });
    await t.press("Escape", { show: false, pause: 500 });
    await t.expect("[data-testid=filter-chip-assignee]");
    await t.caption("条件はチップで表示。クリックで変更、× で解除します");
    await t.highlight("[data-testid=filter-bar]", 1500);
    await t.caption("条件は重ねられます。優先度「緊急」と「高」に絞ります");
    await t.click("[data-testid=filter-button]");
    await t.click(".menu-item:has-text('優先度')");
    await t.click("[data-testid=filter-picker-priority] [role=option]:has-text('緊急')", { pause: 300 });
    await t.click("[data-testid=filter-picker-priority] [role=option]:has-text('高')", { pause: 600 });
    await t.press("Escape", { show: false, pause: 600 });
    await t.expect("[data-testid=filter-chip-priority]", { text: "緊急・高" });
    await t.poster();
    await t.caption("フィルターは画面ごとに保存され、次回もそのままです", { hold: 2600 });
    await t.caption("F キーでもフィルターを開けます。「すべてクリア」で解除");
    await t.click(".filter-bar .link-btn:has-text('すべてクリア')", { pause: 700 });
    await t.expect("[data-testid=filter-bar]", { hidden: true });
  },
});
