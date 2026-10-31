import { describe, expect, it } from 'vitest';
import {
  dragOrder,
  identityOrder,
  isIdentity,
  isPermutation,
  moveToGap,
  remapAfterReorder,
} from './reorder';

describe('reorder', () => {
  it('moves one page down', () => {
    // drag page 0 over page 2 -> [1, 2, 0, 3]
    expect(dragOrder(4, [0], 0, 2)).toEqual([1, 2, 0, 3]);
  });

  it('moves one page up', () => {
    expect(dragOrder(4, [3], 3, 1)).toEqual([0, 3, 1, 2]);
  });

  it('moves a non-contiguous block, keeping relative order', () => {
    // pages 0 and 2 dragged (active 2) over 4
    const order = dragOrder(6, [0, 2], 2, 4);
    expect(order).toEqual([1, 3, 4, 0, 2, 5]);
    expect(isPermutation(order, 6)).toBe(true);
  });

  it('dropping on a dragged page is a no-op', () => {
    expect(isIdentity(dragOrder(5, [1, 2], 1, 2))).toBe(true);
  });

  it('moveToGap handles edges', () => {
    expect(moveToGap(3, [2], 0)).toEqual([2, 0, 1]);
    expect(moveToGap(3, [0], 3)).toEqual([1, 2, 0]);
    expect(moveToGap(3, [1], 1)).toEqual([0, 1, 2]);
  });

  it('remaps the selection', () => {
    const order = [1, 2, 0, 3];
    expect(remapAfterReorder(order, [0])).toEqual([2]);
    expect(remapAfterReorder(order, [0, 3])).toEqual([2, 3]);
  });

  it('validates permutations', () => {
    expect(isPermutation(identityOrder(3), 3)).toBe(true);
    expect(isPermutation([0, 0, 1], 3)).toBe(false);
    expect(isPermutation([0, 1], 3)).toBe(false);
    expect(isPermutation([0, 1, 3], 3)).toBe(false);
  });
});
