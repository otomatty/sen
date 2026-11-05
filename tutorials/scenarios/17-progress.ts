import { defineScenario } from "../lib/types";

const MOBILE = "[data-testid=progress-activity-row]:has-text('モバイルアプリ v2.0')";

export default defineScenario({
  id: "progress",
  order: 17,
  screen: "progress",
  title: "進捗を見る",
  summary: "プロジェクトの進み具合を、活動一覧・WBS・タイムラインで確かめます。数え方はスプレッドシートと同じです。",
  start: "/inbox",
  async run(t) {
    await t.caption("サイドバーの「進捗」で、ワークスペース全体の進み具合が分かります");
    await t.click("[data-testid=nav-progress]");
    await t.expect("[data-testid=progress-page]");

    await t.caption("プロジェクトごとの完了率と状況を、スプレッドシートと同じ数え方で出します");
    await t.expect(`${MOBILE} [data-testid=progress-rate]`, { text: "28%（2/7）" });
    await t.expect(`${MOBILE} [data-testid=progress-status]`, { text: "保留あり" });
    await t.highlight(".progress-cards", 1100);
    await t.highlight(".progress-table", 1100);
    await t.poster();

    await t.caption("状況のボタンで、気になる活動だけに絞れます");
    await t.click("[data-testid='progress-filter-保留あり']", { pause: 1400 });
    await t.expect("[data-testid=progress-activity-row]", { count: 4 });
    await t.click("[data-testid='progress-filter-すべて']", { pause: 800 });
    await t.expect("[data-testid=progress-activity-row]", { count: 5 });

    await t.caption("WBS では、作業が担当・期限・状態つきで並びます");
    await t.click("[data-testid=progress-tab-wbs]");
    await t.expect("[data-testid=wbs-group]", { count: 5 });
    await t.expect("[data-testid=wbs-row][data-identifier='ENG-1']", { text: "iOS でプッシュ通知が届かないことがある" });
    await t.highlight(".wbs-group-head >> nth=0", 1000);
    await t.highlight("[data-testid=wbs-row][data-identifier='ENG-1']", 1100);

    await t.caption("完了を隠したり、担当や工程で絞ったりできます");
    await t.click("[data-testid=wbs-toggle-done]");
    await t.expect("[data-testid=wbs-row][data-identifier='ENG-24']", { hidden: true });
    await t.expect("[data-testid=wbs-row][data-identifier='ENG-1']");
    await t.click("[data-testid=wbs-toggle-done]");
    await t.expect("[data-testid=wbs-row][data-identifier='ENG-24']");

    await t.caption("タイムラインでは、着手日から完了予定までを横棒で見られます");
    await t.click("[data-testid=progress-tab-timeline]");
    const bar = "[data-testid=timeline-row][data-identifier='ENG-1'] [data-testid=timeline-bar]";
    await t.expect(bar);
    await t.expect("[data-testid=timeline-today]");
    await t.hover(bar, 250);
    await t.highlight(bar, 1100);
    await t.highlight("[data-testid=timeline-today]", 900);
    await t.click("[data-testid=timeline-zoom-week]", { pause: 1200 });
    await t.expect("[data-testid=timeline-zoom-week].on");
    await t.click("[data-testid=timeline-zoom-month]", { pause: 700 });
    await t.expect("[data-testid=timeline-zoom-month].on");

    await t.caption("課題を更新すると、進捗もその場で書き変わります");
    await t.click(bar);
    await t.expect("[data-testid=issue-detail][data-identifier='ENG-1']");
    await t.click("[data-testid=prop-status]");
    await t.click("[data-testid=picker-status] [role=option]:has-text('完了')", { pause: 500 });
    await t.expect("[data-testid=prop-status]", { text: "完了" });
    await t.click("[data-testid=nav-progress]");
    await t.expect(`${MOBILE} [data-testid=progress-rate]`, { text: "42%（3/7）" });
    await t.highlight(`${MOBILE} [data-testid=progress-rate]`, 1400);

    await t.caption("行を押すと、プロジェクトや課題を開けます", { hold: 3600 });
    await t.highlight(`${MOBILE} .progress-activity-link`, 1600);
  },
});
