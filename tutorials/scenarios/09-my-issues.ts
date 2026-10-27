import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "my-issues",
  order: 9,
  screen: "my-issues",
  title: "マイイシューで自分の仕事を見る",
  summary: "担当・作成・購読中の課題を切り替えて確認します。I キーで課題を自分に割り当てられます。",
  start: "/my-issues",
  async run(t) {
    await t.caption("マイイシューには、自分が担当している課題がチームをまたいでまとまります");
    await t.click("[data-testid=tab-created]");
    await t.caption("「作成」タブ：自分が起票した課題");
    await t.click("[data-testid=tab-subscribed]");
    await t.caption("「購読中」タブ：通知を受け取っている課題");
    await t.click("[data-testid=tab-assigned]");
    await t.caption("チームの一覧で I キーを押すと、その課題を自分に割り当てられます");
    await t.click("[data-testid=nav-team-ENG-issues]", { pause: 700 });
    await t.click("[data-testid=tab-backlog]", { pause: 700 });
    await t.hover("[data-testid=issue-row][data-identifier='ENG-16']", 500);
    await t.press("i", { pause: 1200 });
    await t.click("[data-testid=nav-my-issues]", { pause: 800 });
    await t.caption("割り当てた課題が、マイイシューに加わりました", { hold: 1800 });
    await t.highlight("[data-testid=issue-row][data-identifier='ENG-16']", 1600);
  },
});
