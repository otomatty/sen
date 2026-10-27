import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "inbox",
  order: 8,
  screen: "inbox",
  title: "受信トレイで通知をさばく",
  summary: "割り当て・コメント・メンションの通知を、キーボードで素早く確認して片付けます。",
  start: "/inbox",
  async run(t) {
    await t.park();
    await t.caption("受信トレイには、割り当て・コメント・メンションの通知が届きます");
    await t.highlight("[data-testid=inbox-list]", 1300);
    await t.poster();
    await t.caption("J / K で通知を移ると、右側に課題がそのまま開きます");
    await t.press("j", { pause: 800 });
    await t.press("j", { pause: 800 });
    await t.expect(".inbox-item.active >> nth=0");
    await t.caption("その場でステータスを変えたり、返信したりできます");
    await t.press("s", { pause: 400 });
    await t.expect("[data-testid=picker-status]");
    await t.type("進行");
    await t.press("Enter", { pause: 800 });
    await t.expect("[data-testid=picker-status]", { hidden: true });
    await t.caption("対応が済んだ通知は、Backspace で片付けます");
    const before = await t.page.locator("[data-testid=inbox-item]").count();
    await t.press("Backspace", { pause: 800 });
    await t.press("Backspace", { pause: 800 });
    await t.expect("[data-testid=inbox-item]", { count: before - 2 });
    await t.caption("U で既読と未読を切り替え。あとで見返すときに便利です");
    await t.press("u", { pause: 900 });
    await t.expect(".inbox-item.active.unread");
    await t.caption("右上のボタンで、すべてまとめて既読にできます");
    await t.click("[data-testid=inbox-mark-all]", { pause: 900 });
    await t.expect(".inbox-item.unread", { count: 0 });
  },
});
