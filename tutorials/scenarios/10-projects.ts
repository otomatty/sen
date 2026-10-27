import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "projects",
  order: 10,
  screen: "projects",
  title: "プロジェクトで目標を管理する",
  summary: "複数の課題にまたがる目標をプロジェクトにまとめ、進捗と目標日を追いかけます。",
  start: "/projects",
  async run(t) {
    await t.caption("プロジェクトは、複数の課題にまたがる目標をまとめる単位です。進捗は自動で集計されます");
    await t.highlight("[data-testid=project-row] >> nth=0", 1400);
    await t.caption("新しいプロジェクトを作ってみます");
    await t.click("[data-testid=new-project]");
    await t.type("請求書のダウンロード機能");
    await t.caption("目標日やリードを決めて作成します", { hold: 1400 });
    await t.click(".form-grid .input-like");
    await t.click("[data-testid=date-picker] .datepicker-quick button:has-text('2週間後')", { pause: 500 });
    await t.click("[data-testid=project-create-submit]", { pause: 1200 });
    await t.caption("概要には説明・進捗・チャートがまとまります。ここから課題を追加します");
    await t.click("button:has-text('課題を追加')");
    await t.type("請求書 PDF を生成する API");
    await t.press("Meta+Enter", { pause: 900 });
    await t.click("button:has-text('課題を追加')");
    await t.type("請求書一覧の画面を作る");
    await t.press("Meta+Enter", { pause: 900 });
    await t.click("[data-testid=project-tab-issues]");
    await t.caption("「課題」タブでは、このプロジェクトの課題だけを一覧できます");
    await t.caption("★ でお気に入りに追加すると、サイドバーからすぐに開けます", { hold: 1200 });
    await t.click("[data-testid=project-favorite]", { pause: 900 });
    await t.highlight(".sidebar-nav .nav-item:has-text('請求書のダウンロード機能')", 1800);
  },
});
