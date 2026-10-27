import { defineScenario } from "../lib/types";

export default defineScenario({
  id: "command-palette",
  order: 7,
  screen: "palette",
  title: "コマンドパレット",
  summary: "⌘K で開くコマンドパレットから、移動・作成・変更・検索まで、ほぼすべての操作ができます。",
  start: "/team/ENG/active",
  async run(t) {
    await t.park();
    await t.caption("⌘K（Ctrl+K）でコマンドパレットを開きます");
    await t.press("Meta+k", { pause: 600 });
    await t.expect("[data-testid=command-palette]");
    await t.poster();
    await t.caption("やりたいことを入力して Enter。表示をボードにします");
    await t.type("ボード表示");
    await t.expect("[data-testid=palette-item] >> nth=0", { text: "ボード" });
    await t.press("Enter", { pause: 900 });
    await t.expect("[data-testid=board]");
    await t.caption("課題も探せます。入力すると、その場で候補が出ます");
    await t.press("Meta+k", { pause: 400 });
    await t.type("決済");
    await t.expect("[data-testid=palette-item]", { text: "決済" });
    await t.wait(700);
    await t.press("Enter", { pause: 900 });
    await t.expect("[data-testid=issue-detail]");
    await t.caption("課題を開いていると、その課題への操作が先頭に並びます");
    await t.press("Meta+k", { pause: 1000 });
    await t.type("優先");
    await t.press("Enter", { pause: 600 });
    await t.expect("[data-testid=picker-priority]");
    await t.press("2", { pause: 800 });
    await t.expect("[data-testid=prop-priority]", { text: "高" });
    await t.caption("テーマの切り替えも、パレットから呼び出せます");
    await t.press("Meta+k", { pause: 400 });
    await t.type("ライト");
    await t.press("Enter", { pause: 1500 });
    await t.press("Meta+k", { pause: 400 });
    await t.type("ダーク");
    await t.press("Enter", { pause: 900 });
  },
});
