import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "search",
  order: 12,
  screen: "search",
  title: "課題を検索する",
  summary: "/ キーで検索。タイトル・説明・ID から、待ち時間なしで結果が表示されます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.moveToPoint(110, 720);
    await t.caption("/ キーで、どこからでも検索を開けます");
    await t.press("/", { pause: 800 });
    await t.type("通知");
    await t.caption("データは手元にあるので、入力した瞬間に結果が表示されます", { hold: 2200 });
    await t.caption("↓ で結果に移り、Enter で開きます", { hold: 1200 });
    await t.press("ArrowDown", { pause: 600 });
    await t.press("Enter", { pause: 1400 });
    await t.caption("課題 ID でも探せます");
    await t.press("/", { pause: 600 });
    await t.type("ENG-12");
    await t.wait(1400);
  },
});
