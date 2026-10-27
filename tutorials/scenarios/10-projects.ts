import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "projects",
  order: 10,
  screen: "projects",
  title: "プロジェクトで目標を管理する",
  summary: "複数の課題にまたがる目標をプロジェクトにまとめ、進捗と目標日を追いかけます。",
  start: "/projects",
  async run(t) {
    await t.caption("プロジェクトは、複数の課題にまたがる目標の単位です");
    await t.highlight("[data-testid=project-row] >> nth=0", 1300);
    await t.caption("進み具合は、課題の状況から自動で集計されます", { hold: 1800 });
    await t.caption("新しいプロジェクトを作ってみます");
    await t.click("[data-testid=new-project]");
    await t.expect("[data-testid=project-create-modal]");
    await t.type("請求書のダウンロード機能");
    await t.caption("目標日やリードを決めて作成します");
    await t.click(".form-grid .input-like");
    await t.click("[data-testid=date-picker] .datepicker-quick button:has-text('2週間後')", { pause: 400 });
    await t.click("[data-testid=project-create-submit]", { pause: 900 });
    await t.expect("[data-testid=project-page]");
    await t.caption("概要から、そのまま課題を追加できます");
    await t.click("button:has-text('課題を追加')");
    await t.type("請求書 PDF を生成する API");
    await t.press("Meta+Enter", { pause: 800 });
    await t.click("button:has-text('課題を追加')");
    await t.type("請求書一覧の画面を作る");
    await t.press("Meta+Enter", { pause: 800 });
    await t.expect("[data-testid=project-page]", { text: "2" });
    await t.poster();
    await t.caption("「課題」タブには、このプロジェクトの課題だけが並びます");
    await t.click("[data-testid=project-tab-issues]");
    await t.expect("[data-testid=issue-row]", { count: 2 });
    await t.caption("★ でお気に入りにすると、サイドバーから開けます");
    await t.click("[data-testid=project-favorite]", { pause: 700 });
    await t.expect(".sidebar-nav .nav-item:has-text('請求書のダウンロード機能')");
    await t.highlight(".sidebar-nav .nav-item:has-text('請求書のダウンロード機能')", 1600);
  },
});
