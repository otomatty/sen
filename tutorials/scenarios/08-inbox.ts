import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "inbox",
  order: 8,
  screen: "inbox",
  title: "受信トレイで通知をさばく",
  summary: "割り当て・コメント・メンションの通知を、キーボードで素早く確認して片付けます。",
  start: "/inbox",
  async run(t) {
    await t.moveToPoint(110, 720);
    await t.caption("受信トレイには、割り当て・コメント・メンションの通知が届きます");
    await t.highlight("[data-testid=inbox-list]", 1400);
    await t.caption("J / K で通知を移動すると、右側に課題がそのまま表示されます");
    await t.press("j", { pause: 900 });
    await t.press("j", { pause: 900 });
    await t.caption("その場でステータスを変えたり、コメントを返したりできます");
    await t.press("s", { pause: 500 });
    await t.type("進行");
    await t.press("Enter", { pause: 1000 });
    await t.caption("対応が終わった通知は Backspace で片付けます");
    await t.press("Backspace", { pause: 900 });
    await t.press("Backspace", { pause: 900 });
    await t.caption("U で既読と未読を切り替えられます。あとで見返したいときに便利です");
    await t.press("u", { pause: 1000 });
    await t.caption("右上のボタンで、すべての通知をまとめて既読にできます");
    await t.click("[data-testid=inbox-mark-all]", { pause: 1200 });
  },
});
