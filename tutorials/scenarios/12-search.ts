import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "search",
  order: 12,
  screen: "search",
  title: "課題を検索する",
  summary: "/ キーで検索。タイトル・説明・ID から、待ち時間なしで結果が表示されます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.park();
    await t.caption("/ キーで、どこからでも検索を開けます");
    await t.press("/", { pause: 600 });
    await t.expect("[data-testid=search-input]");
    await t.type("通知");
    await t.expect("[data-testid=issue-row]", { text: "通知" });
    await t.poster();
    await t.caption("入力したそばから、結果が絞り込まれます", { hold: 2000 });
    await t.caption("↓ で結果に移り、Enter で開きます");
    await t.press("ArrowDown", { pause: 500 });
    await t.press("Enter", { pause: 1000 });
    await t.expect("[data-testid=issue-detail]");
    await t.caption("課題の ID でも探せます");
    await t.press("/", { pause: 500 });
    await t.type("ENG-12");
    await t.expect("[data-testid=issue-row]", { count: 1 });
    await t.wait(1200);
  },
});
