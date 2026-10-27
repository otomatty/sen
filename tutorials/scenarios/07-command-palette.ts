import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "command-palette",
  order: 7,
  screen: "palette",
  title: "コマンドパレット",
  summary: "⌘K で開くコマンドパレットから、移動・作成・変更・検索まで、ほぼすべての操作ができます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.moveToPoint(110, 720);
    await t.caption("⌘K（Ctrl+K）でコマンドパレットを開きます");
    await t.press("Meta+k", { pause: 900 });
    await t.caption("やりたいことを入力して Enter。ここでは表示をボードに切り替えます");
    await t.type("ボード表示");
    await t.press("Enter", { pause: 1200 });
    await t.caption("課題の検索もできます。キーワードを入力すると、その場で候補が出ます");
    await t.press("Meta+k", { pause: 500 });
    await t.type("決済");
    await t.wait(900);
    await t.press("Enter", { pause: 1200 });
    await t.caption("課題を開いているときは、その課題への操作が先頭に並びます");
    await t.press("Meta+k", { pause: 1200 });
    await t.type("優先");
    await t.press("Enter", { pause: 700 });
    await t.press("2", { pause: 1000 });
    await t.caption("テーマの切り替えなどの設定も、パレットから呼び出せます");
    await t.press("Meta+k", { pause: 400 });
    await t.type("ライト");
    await t.press("Enter", { pause: 1600 });
    await t.press("Meta+k", { pause: 400 });
    await t.type("ダーク");
    await t.press("Enter", { pause: 1200 });
  },
});
