import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "keyboard",
  order: 3,
  screen: "issues",
  title: "キーボードで課題を操作する",
  summary: "J / K で移動し、S・P・A・L でステータスや優先度を変更。X で複数選択してまとめて操作します。",
  start: "/team/ENG/active",
  async run(t) {
    const focused = "[data-testid=issue-row].focused";
    await t.park();
    await t.caption("J と K で、一覧のフォーカスを上下に動かします");
    await t.press("j", { pause: 350 });
    await t.press("j", { pause: 350 });
    await t.press("j", { pause: 500 });
    await t.expect(focused);
    await t.caption("S でステータスを変更。文字を入力して絞り込めます");
    await t.press("s", { pause: 400 });
    await t.expect("[data-testid=picker-status]");
    await t.type("レビュー");
    await t.press("Enter", { pause: 700 });
    await t.expect("[data-testid=issue-group][data-group='レビュー中'] [data-testid=issue-row].focused");
    await t.poster();
    await t.caption("P で優先度。数字キーでもすぐ選べます（1 = 緊急）");
    await t.press("p", { pause: 500 });
    await t.expect("[data-testid=picker-priority]");
    await t.press("1", { pause: 700 });
    await t.expect("[data-testid=picker-priority]", { hidden: true });
    await t.caption("A で担当者を変更します");
    await t.press("a", { pause: 400 });
    await t.expect("[data-testid=picker-assignee]");
    await t.type("佐藤");
    await t.press("Enter", { pause: 700 });
    await t.expect(`${focused} .avatar[title='佐藤 花子']`);
    await t.caption("X で選ぶと、複数の課題をまとめて操作できます");
    await t.press("x", { pause: 300 });
    await t.press("j", { pause: 300 });
    await t.press("x", { pause: 300 });
    await t.press("j", { pause: 300 });
    await t.press("x", { pause: 700 });
    await t.expect("[data-testid=selection-bar]", { text: "3件" });
    await t.caption("選択中も同じキーが使えます。L でラベルを追加");
    await t.press("l", { pause: 400 });
    await t.type("改善");
    await t.press("Enter", { pause: 400 });
    await t.press("Escape", { show: false, pause: 700 });
    await t.caption("Esc で選択を解除。⌘Z（Ctrl+Z）で元に戻せます");
    await t.press("Escape", { pause: 500 });
    await t.expect("[data-testid=selection-bar]", { hidden: true });
    await t.press("Meta+z", { pause: 400 });
    await t.expect("[data-testid=toast]", { text: "元に戻しました" });
    await t.wait(1000);
  },
});
