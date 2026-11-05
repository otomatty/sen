export type OrderItem = { id: string; sortOrder: number };
export type MoveAnchor = { beforeId: string } | { afterId: string };

/**
 * 並びを変えたときに保存する sortOrder を返す。
 * ordered はワークスペース全体のプロジェクト（表示順）。movedId を anchor の直前（beforeId）か直後（afterId）に入れる。
 */
export function planProjectMove(ordered: OrderItem[], movedId: string, anchor: MoveAnchor): OrderItem[] {
  const moved = ordered.find((item) => item.id === movedId);
  if (!moved) return [];
  const rest = ordered.filter((item) => item.id !== movedId);
  const anchorId = "beforeId" in anchor ? anchor.beforeId : anchor.afterId;
  const anchorIndex = rest.findIndex((item) => item.id === anchorId);
  if (anchorIndex < 0) return [];

  const idx = "beforeId" in anchor ? anchorIndex : anchorIndex + 1;
  const prev = rest[idx - 1]?.sortOrder;
  const next = rest[idx]?.sortOrder;

  if (prev !== undefined && next !== undefined) {
    const candidate = (prev + next) / 2;
    // 前後が同じ、または中間が表現できないときは全体を振り直す
    if (prev < candidate && candidate < next) return [{ id: movedId, sortOrder: candidate }];
    return reassign(rest, idx, moved);
  }
  if (prev !== undefined) return [{ id: movedId, sortOrder: prev + 1 }];
  if (next !== undefined) return [{ id: movedId, sortOrder: next - 1 }];
  return [];
}

/** rest の idx に動かしたものを入れ、先頭から 1, 2, 3… を割り当てる。値が変わるものだけ返す */
function reassign(rest: OrderItem[], idx: number, moved: OrderItem): OrderItem[] {
  const placed = [...rest.slice(0, idx), moved, ...rest.slice(idx)];
  const updates: OrderItem[] = [];
  placed.forEach((item, index) => {
    const sortOrder = index + 1;
    if (item.sortOrder !== sortOrder) updates.push({ id: item.id, sortOrder });
  });
  return updates;
}
