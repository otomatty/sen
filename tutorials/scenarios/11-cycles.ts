import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "cycles",
  order: 11,
  screen: "cycles",
  title: "サイクルでリズムを作る",
  summary: "1〜4週間の区切りで計画と振り返りを行います。進み具合はグラフで確認できます。",
  start: "/team/ENG/cycles",
  async run(t) {
    await t.caption("サイクルは 1〜4 週間の区切りです");
    await t.highlight("[data-testid=current-cycle] .cycle-stats", 1400);
    await t.poster();
    await t.caption("いまのサイクルの進み具合が、ひと目で分かります", { hold: 1800 });
    await t.caption("グラフは、スコープ・進行中・完了の推移です");
    await t.highlight("[data-testid=current-cycle] .burnup", 1600);
    const scope = Number(await t.page.locator("[data-testid=current-cycle] .cycle-stats > div >> nth=1").locator("b").textContent());
    await t.caption("バックログの課題を、今のサイクルに入れてみます");
    await t.click("[data-testid=nav-team-ENG-issues]", { pause: 500 });
    await t.click("[data-testid=tab-backlog]", { pause: 600 });
    await t.hover("[data-testid=issue-row][data-identifier='ENG-17']", 400);
    await t.caption("Shift + C でサイクルを選びます");
    await t.press("Shift+c", { pause: 500 });
    await t.click("[data-testid=picker-cycle] [role=option]:has-text('現在')", { pause: 700 });
    await t.click("[data-testid=nav-team-ENG-cycles]", { pause: 700 });
    await t.expect("[data-testid=current-cycle] .cycle-stats > div >> nth=1", { text: String(scope + 1) });
    await t.caption("スコープが増え、統計とグラフに反映されました", { hold: 2000 });
    await t.click("[data-testid=current-cycle] button:has-text('課題を見る')", { pause: 800 });
    await t.expect("[data-testid=issue-list]");
    await t.caption("サイクルの課題一覧です", { hold: 1400 });
    await t.caption("終わらなかった課題は、次のサイクルに持ち越して計画します", { hold: 2400 });
  },
});
