/**
 * Reorder helpers producing the `order` permutation for `page.reorder`:
 * new page i = old page order[i] (CONTRACTS §6).
 */

export function identityOrder(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

export function isIdentity(order: readonly number[]): boolean {
  return order.every((v, i) => v === i);
}

/**
 * Move the `moving` pages (sorted, kept contiguous) to the gap before `gap`,
 * where gap is in [0, count] and refers to the ORIGINAL indices.
 */
export function moveToGap(count: number, moving: readonly number[], gap: number): number[] {
  const set = new Set(moving);
  const block = [...set].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  const result: number[] = [];
  for (let i = 0; i <= count; i++) {
    if (i === gap) result.push(...block);
    if (i < count && !set.has(i)) result.push(i);
  }
  return result;
}

/**
 * Order after a drag of `active` (with `moving` = all dragged pages, including
 * `active`) dropped over `over`. Dragging down places the block after `over`,
 * dragging up places it before `over` (same feel as dnd-kit's arrayMove).
 */
export function dragOrder(
  count: number,
  moving: readonly number[],
  active: number,
  over: number,
): number[] {
  if (moving.includes(over)) return identityOrder(count);
  return moveToGap(count, moving, over > active ? over + 1 : over);
}

/** New indices of `pages` after applying `order`. */
export function remapAfterReorder(order: readonly number[], pages: readonly number[]): number[] {
  const inverse = new Map(order.map((old, i) => [old, i]));
  return pages
    .map((p) => inverse.get(p))
    .filter((p): p is number => p !== undefined)
    .sort((a, b) => a - b);
}

/** Validate that `order` is a full permutation of [0, count). */
export function isPermutation(order: readonly number[], count: number): boolean {
  if (order.length !== count) return false;
  const seen = new Set(order);
  return seen.size === count && order.every((v) => Number.isInteger(v) && v >= 0 && v < count);
}
