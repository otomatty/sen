import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "issue-detail",
  order: 6,
  screen: "issue",
  title: "課題の詳細を編集する",
  summary: "プロパティの変更、Markdown での説明、サブ課題、@メンション付きのコメントまで。",
  start: "/team/ENG/all",
  async run(t) {
    await t.caption("課題をクリックすると、詳細が開きます");
    await t.click("[data-testid=issue-row][data-identifier='ENG-15']", { pause: 700 });
    await t.expect("[data-testid=issue-detail][data-identifier='ENG-15']");
    await t.caption("右側のプロパティは、クリックしてその場で変更できます");
    await t.click("[data-testid=prop-status]");
    await t.click("[data-testid=picker-status] [role=option]:has-text('進行中')", { pause: 500 });
    await t.expect("[data-testid=prop-status]", { text: "進行中" });
    await t.click("[data-testid=prop-due]");
    await t.click("[data-testid=date-picker] .datepicker-quick button:has-text('明日')", { pause: 600 });
    await t.caption("説明は Markdown で書けます。## で見出し、- で箇条書き");
    await t.click("[data-testid=issue-description]");
    await t.type("## 調査メモ");
    await t.press("Enter", { show: false, pause: 200 });
    await t.type("- SPF レコードの設定を確認");
    await t.press("Enter", { show: false, pause: 200 });
    await t.type("送信元ドメインを統一する");
    await t.press("Escape", { show: false, pause: 400 });
    await t.expect("[data-testid=issue-description] h2", { text: "調査メモ" });
    await t.poster();
    await t.caption("大きな作業は、サブ課題に分けて進められます");
    await t.click("[data-testid=add-sub-issue]");
    await t.type("DKIM の署名を追加する");
    await t.press("Enter", { pause: 400 });
    await t.press("Escape", { show: false, pause: 500 });
    await t.expect("[data-testid=sub-issues]", { text: "DKIM の署名を追加する" });
    await t.caption("コメントで @ を入力すると、メンバーに通知できます");
    await t.click("[data-testid=comment-input]");
    await t.type("@佐藤");
    await t.expect("[data-testid=mention-menu]");
    await t.wait(300);
    await t.press("Enter", { show: false, pause: 300 });
    await t.type("設定変更のレビューをお願いします！");
    await t.caption("⌘ + Enter（Ctrl + Enter）で送信します");
    await t.press("Meta+Enter", { pause: 700 });
    await t.expect("[data-testid=comment] >> nth=-1", { text: "レビューをお願いします" });
    await t.caption("変更の履歴とコメントは、時系列でまとまります", { hold: 2200 });
    await t.caption("J / K で前後の課題へ、Esc で一覧に戻ります");
    await t.park();
    await t.press("j", { pause: 800 });
    await t.press("Escape", { pause: 600 });
    await t.expect("[data-testid=issue-list]");
  },
});
