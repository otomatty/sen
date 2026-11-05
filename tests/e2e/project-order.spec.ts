import { expect, test } from "@playwright/test";
import { planProjectMove, type OrderItem } from "../../src/lib/projectOrder";

/** 返ってきた値を当てはめ、sortOrder の昇順（同じ値なら元の配列の順）の id を返す */
function idsInOrder(items: OrderItem[], updates: OrderItem[]): string[] {
  const sortOrder = new Map(items.map((item) => [item.id, item.sortOrder]));
  for (const update of updates) sortOrder.set(update.id, update.sortOrder);
  return items
    .map((item, index) => ({ id: item.id, sortOrder: sortOrder.get(item.id) ?? item.sortOrder, index }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.index - b.index)
    .map((item) => item.id);
}

/** 更新を当てはめた表示順。次の移動の入力に使う */
function applied(items: OrderItem[], updates: OrderItem[]): OrderItem[] {
  const sortOrder = new Map(items.map((item) => [item.id, item.sortOrder]));
  for (const update of updates) sortOrder.set(update.id, update.sortOrder);
  return items
    .map((item, index) => ({ id: item.id, sortOrder: sortOrder.get(item.id) ?? item.sortOrder, index }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.index - b.index)
    .map(({ id, sortOrder }) => ({ id, sortOrder }));
}

const row = (id: string, sortOrder: number): OrderItem => ({ id, sortOrder });

test.describe("プロジェクトの並び順", () => {
  test("前後の値が違う間に入れると中間の値を1件返す", () => {
    const items = [row("A", 1), row("B", 3), row("C", 5)];
    const updates = planProjectMove(items, "C", { beforeId: "B" });
    expect(updates).toEqual([{ id: "C", sortOrder: 2 }]);
    expect(idsInOrder(items, updates)).toEqual(["A", "C", "B"]);
  });

  test("一番上へ動かすと先頭の値から1を引き、一番下へ動かすと末尾の値に1を足す", () => {
    const items = [row("A", 2), row("B", 4), row("C", 6)];
    const top = planProjectMove(items, "C", { beforeId: "A" });
    expect(top).toEqual([{ id: "C", sortOrder: 1 }]);
    expect(idsInOrder(items, top)).toEqual(["C", "A", "B"]);

    const bottom = planProjectMove(items, "A", { afterId: "C" });
    expect(bottom).toEqual([{ id: "A", sortOrder: 7 }]);
    expect(idsInOrder(items, bottom)).toEqual(["B", "C", "A"]);
  });

  test("見えていないプロジェクトと値が重ならないよう間を取り、続けて動かすとドロップ位置に並ぶ", () => {
    const items = [row("A", 1), row("B", 2), row("C", 3), row("D", 4)];
    const movedC = planProjectMove(items, "C", { beforeId: "B" });
    expect(movedC).toEqual([{ id: "C", sortOrder: 1.5 }]);
    const afterC = applied(items, movedC);
    const movedD = planProjectMove(afterC, "D", { beforeId: "C" });
    expect(movedD).toHaveLength(1);
    expect(idsInOrder(afterC, movedD)).toEqual(["A", "D", "C", "B"]);
  });

  test("前後が同じ値のときは振り直してドロップ位置に並ぶ", () => {
    const items = [row("A", 1), row("B", 1), row("C", 1)];
    const updates = planProjectMove(items, "C", { beforeId: "B" });
    const next = applied(items, updates);
    expect(updates).toHaveLength(2);
    expect(idsInOrder(items, updates)).toEqual(["A", "C", "B"]);
    expect(new Set(next.map((item) => item.sortOrder)).size).toBe(next.length);
  });

  test("中間の細かさが尽きたときは振り直す", () => {
    const items = [row("A", 1), row("B", 1 + Number.EPSILON), row("C", 3)];
    const updates = planProjectMove(items, "C", { beforeId: "B" });
    expect(updates).toHaveLength(2);
    expect(idsInOrder(items, updates)).toEqual(["A", "C", "B"]);
  });

  test("anchor が見つからない、自分自身、1件だけなら空を返す", () => {
    const items = [row("A", 1), row("B", 2)];
    const missing = planProjectMove(items, "A", { beforeId: "無い" });
    const self = planProjectMove(items, "A", { beforeId: "A" });
    const only = planProjectMove([row("A", 1)], "A", { beforeId: "A" });
    expect(missing).toEqual([]);
    expect(self).toEqual([]);
    expect(planProjectMove(items, "A", { afterId: "A" })).toEqual([]);
    expect(only).toEqual([]);
    expect(idsInOrder(items, missing)).toEqual(["A", "B"]);
    expect(idsInOrder(items, self)).toEqual(["A", "B"]);
    expect(idsInOrder([row("A", 1)], only)).toEqual(["A"]);
  });
});
