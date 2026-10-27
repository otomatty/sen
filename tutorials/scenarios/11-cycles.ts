import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "cycles",
  order: 11,
  screen: "cycles",
  title: "サイクルでリズムを作る",
  summary: "1〜4週間の区切りで計画と振り返りを行います。進み具合はグラフで確認できます。",
  start: "/team/ENG/cycles",
  async run(t) {
    await t.caption("サイクルは 1〜4 週間の区切りです。いまのサイクルの進み具合がひと目で分かります");
    await t.highlight("[data-testid=current-cycle] .cycle-stats", 1500);
    await t.caption("グラフは、範囲（灰色）・進行中（黄色）・完了（青）の推移を表します");
    await t.highlight("[data-testid=current-cycle] .burnup", 1600);
    await t.caption("バックログの課題を、今のサイクルに入れてみます");
    await t.click("[data-testid=nav-team-ENG-issues]", { pause: 600 });
    await t.click("[data-testid=tab-backlog]", { pause: 700 });
    await t.hover("[data-testid=issue-row][data-identifier='ENG-17']", 500);
    await t.caption("Shift + C でサイクルを選びます");
    await t.press("Shift+c", { pause: 600 });
    await t.click("[data-testid=picker-cycle] [role=option]:has-text('現在')", { pause: 900 });
    await t.click("[data-testid=nav-team-ENG-cycles]", { pause: 900 });
    await t.caption("範囲が増えたことが、統計とグラフに反映されます", { hold: 2000 });
    await t.click("[data-testid=current-cycle] button:has-text('課題を見る')", { pause: 1000 });
    await t.caption("サイクルの課題一覧。期間が終わると、完了しなかった課題は次のサイクルに持ち越して計画します", { hold: 3200 });
  },
});
