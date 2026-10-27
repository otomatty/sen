import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "board",
  order: 4,
  screen: "board",
  title: "ボード表示とドラッグ＆ドロップ",
  summary: "⌘B でリストとボードを切り替え。カードをドラッグしてステータスを変更できます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.park();
    await t.caption("⌘B（Ctrl+B）で、リストとボードを切り替えます");
    await t.press("Meta+b", { pause: 900 });
    await t.expect("[data-testid=board]");
    await t.poster();
    await t.caption("カードを別の列へドラッグすると、ステータスが変わります");
    await t.drag(
      "[data-testid=board-card][data-identifier='ENG-7']",
      "[data-testid=board-column][data-group='進行中'] [data-testid=board-card] >> nth=0",
      { offsetY: 14 },
    );
    await t.expect("[data-testid=board-column][data-group='進行中'] [data-identifier='ENG-7']");
    await t.caption("作業を始めた時刻も、自動で記録されます", { hold: 2000 });
    await t.caption("カードのアイコンから、担当者なども直接変えられます");
    await t.click("[data-testid=board-card][data-identifier='ENG-7'] .card-top .row-icon-btn");
    await t.click("[data-testid=picker-assignee] [role=option]:has-text('自分')");
    await t.expect("[data-testid=picker-assignee]", { hidden: true });
    await t.caption("表示設定で、グループ分けや並び順を変えられます");
    await t.click("[data-testid=display-button]");
    await t.wait(400);
    await t.moveTo("[data-testid=display-grouping]");
    await t.page.selectOption("[data-testid=display-grouping]", "assignee");
    await t.expect("[data-testid=board-column][data-group='伊藤 さくら']");
    await t.caption("担当者ごとに並べると、誰が何を抱えているかが分かります", { hold: 2600 });
    await t.page.selectOption("[data-testid=display-grouping]", "status");
    await t.press("Escape", { show: false, pause: 400 });
    await t.caption("もう一度 ⌘B でリストに戻ります");
    await t.press("Meta+b", { pause: 700 });
    await t.expect("[data-testid=issue-list]");
    await t.wait(600);
  },
});
