import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "filters",
  order: 5,
  screen: "issues",
  title: "フィルターで絞り込む",
  summary: "担当者・優先度・ラベルなどの条件で一覧を絞り込みます。条件は画面ごとに保存されます。",
  start: "/team/ENG/all",
  async run(t) {
    await t.caption("フィルターで、表示する課題を絞り込みます（F キーでも開けます）");
    await t.click("[data-testid=filter-button]");
    await t.click(".menu-item:has-text('担当者')");
    await t.click("[data-testid=filter-picker-assignee] [role=option]:has-text('自分')", { pause: 700 });
    await t.press("Escape", { show: false, pause: 600 });
    await t.caption("条件はチップで表示されます。クリックで変更、× で解除できます");
    await t.highlight("[data-testid=filter-bar]", 1500);
    await t.caption("条件は重ねられます。優先度が「緊急」と「高」のものだけにしてみます");
    await t.click("[data-testid=filter-button]");
    await t.click(".menu-item:has-text('優先度')");
    await t.click("[data-testid=filter-picker-priority] [role=option]:has-text('緊急')", { pause: 300 });
    await t.click("[data-testid=filter-picker-priority] [role=option]:has-text('高')", { pause: 700 });
    await t.press("Escape", { show: false, pause: 900 });
    await t.caption("フィルターと表示設定は画面ごとに保存され、次に開いたときもそのままです", { hold: 2600 });
    await t.click(".filter-bar .link-btn:has-text('すべてクリア')", { pause: 900 });
  },
});
