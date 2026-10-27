import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "my-issues",
  order: 9,
  screen: "my-issues",
  title: "自分の課題をまとめて見る",
  summary: "担当・作成・購読中の課題を切り替えて確認します。I キーで課題を自分に割り当てられます。",
  start: "/my-issues",
  async run(t) {
    await t.caption("担当している課題が、チームをまたいでまとまります");
    await t.expect("[data-testid=tab-assigned].active");
    await t.poster();
    await t.settle();
    await t.click("[data-testid=tab-created]");
    await t.caption("「作成」タブには、自分が起票した課題が並びます");
    await t.click("[data-testid=tab-subscribed]");
    await t.caption("「購読中」タブは、通知を受け取っている課題です");
    await t.click("[data-testid=tab-assigned]");
    await t.caption("チームの一覧で I を押すと、自分に割り当てられます");
    await t.click("[data-testid=nav-team-ENG-issues]", { pause: 600 });
    await t.click("[data-testid=tab-backlog]", { pause: 600 });
    await t.hover("[data-testid=issue-row][data-identifier='ENG-16']", 500);
    await t.press("i", { pause: 900 });
    await t.expect("[data-testid=issue-row][data-identifier='ENG-16'] .row-assignee .avatar[title='山田 太郎']");
    await t.click("[data-testid=nav-my-issues]", { pause: 700 });
    await t.expect("[data-testid=issue-row][data-identifier='ENG-16']");
    await t.caption("割り当てた課題が「自分の課題」に加わりました", { hold: 1800 });
    await t.highlight("[data-testid=issue-row][data-identifier='ENG-16']", 1500);
  },
});
