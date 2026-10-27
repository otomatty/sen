import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "relations",
  order: 14,
  screen: "issue",
  title: "課題どうしの関係を示す",
  summary: "「ブロックされている」「関連」「重複」で、課題のつながりと、進められない理由を見えるようにします。",
  start: "/issue/ENG-20",
  async run(t) {
    await t.park();
    await t.expect("[data-testid=relation-row][data-kind=blockedBy][data-identifier='ENG-2']");
    await t.caption("この課題は、ENG-2 が終わるまで進められません");
    await t.highlight("[data-testid=relations]", 1600);
    await t.caption("ブロックされている課題には、一覧でも印が付きます");
    await t.goto("/team/ENG/all");
    await t.expect("[data-testid=issue-row][data-identifier='ENG-20'] [data-testid=blocked-chip]");
    await t.highlight("[data-testid=issue-row][data-identifier='ENG-20']", 1400);
    await t.caption("関係を追加してみます。課題を開いて…");
    await t.click("[data-testid=issue-row][data-identifier='ENG-14']", { pause: 600 });
    await t.expect("[data-testid=issue-detail][data-identifier='ENG-14']");
    await t.park();
    await t.caption("M → B で「ブロックされている」課題を指定します");
    await t.press("m b", { pause: 400 });
    await t.expect("[data-testid=picker-relation]");
    await t.type("v3");
    await t.press("Enter", { pause: 800 });
    await t.expect("[data-testid=relation-row][data-kind=blockedBy][data-identifier='ENG-20']");
    await t.poster();
    await t.caption("M → R で関連、M → M で重複としてマークできます", { hold: 2200 });
    await t.caption("相手の課題からも、関係をたどれます");
    await t.click("[data-testid=relation-row][data-identifier='ENG-20']", { pause: 700 });
    await t.expect("[data-testid=relation-row][data-kind=blocks][data-identifier='ENG-14']");
    await t.highlight("[data-testid=relations]", 1600);
  },
});
