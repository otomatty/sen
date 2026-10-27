import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "board",
  order: 4,
  screen: "board",
  title: "ボード表示とドラッグ＆ドロップ",
  summary: "⌘B でリストとボードを切り替え。カードをドラッグしてステータスを変更できます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.moveToPoint(110, 720);
    await t.caption("⌘B（Ctrl+B）で、リストとボード（カンバン）を切り替えます");
    await t.press("Meta+b", { pause: 1200 });
    await t.caption("カードをドラッグして別の列に移すと、ステータスが変わります");
    await t.drag(
      "[data-testid=board-card][data-identifier='ENG-7']",
      "[data-testid=board-column][data-group='進行中'] [data-testid=board-card] >> nth=0",
      { offsetY: 14 },
    );
    await t.caption("ステータスと同時に、作業開始の時刻も自動で記録されます", { hold: 2200 });
    await t.caption("カードのアイコンから、担当者などを直接変えることもできます");
    await t.click("[data-testid=board-card][data-identifier='ENG-7'] .card-top .row-icon-btn");
    await t.click("[data-testid=picker-assignee] [role=option]:has-text('自分')");
    await t.caption("表示設定では、グループ分け・並び順・表示する項目を変えられます");
    await t.click("[data-testid=display-button]");
    await t.wait(500);
    await t.moveTo("[data-testid=display-grouping]");
    await t.page.selectOption("[data-testid=display-grouping]", "assignee");
    await t.caption("たとえば担当者ごとに並べると、誰が何を抱えているかが分かります", { hold: 2600 });
    await t.page.selectOption("[data-testid=display-grouping]", "status");
    await t.press("Escape", { show: false, pause: 500 });
    await t.caption("もう一度 ⌘B でリストに戻ります", { hold: 1200 });
    await t.press("Meta+b", { pause: 1000 });
  },
});
