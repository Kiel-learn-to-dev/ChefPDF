import { describe, expect, it } from 'vitest';
import {
  clampSelection,
  clickSelect,
  emptySelection,
  invertSelection,
  moveFocus,
  pressSelect,
  selectAll,
  selectByParity,
} from './selection';

describe('selection', () => {
  it('plain click selects one', () => {
    const s = clickSelect(emptySelection, 3);
    expect(s).toEqual({ selected: [3], anchor: 3, focus: 3 });
  });

  it('shift click selects a range from the anchor', () => {
    let s = clickSelect(emptySelection, 2);
    s = clickSelect(s, 5, { shift: true });
    expect(s.selected).toEqual([2, 3, 4, 5]);
    s = clickSelect(s, 0, { shift: true });
    expect(s.selected).toEqual([0, 1, 2]);
    expect(s.anchor).toBe(2);
  });

  it('ctrl click toggles', () => {
    let s = clickSelect(emptySelection, 1);
    s = clickSelect(s, 4, { toggle: true });
    expect(s.selected).toEqual([1, 4]);
    s = clickSelect(s, 1, { toggle: true });
    expect(s.selected).toEqual([4]);
  });

  it('ctrl+shift adds a range', () => {
    let s = clickSelect(emptySelection, 0);
    s = clickSelect(s, 5, { toggle: true });
    s = clickSelect(s, 7, { toggle: true, shift: true });
    expect(s.selected).toEqual([0, 5, 6, 7]);
  });

  it('press keeps an existing multi-selection', () => {
    const s = pressSelect({ selected: [1, 2, 3], anchor: 1, focus: 3 }, 2);
    expect(s.selected).toEqual([1, 2, 3]);
    expect(s.focus).toBe(2);
    expect(pressSelect(s, 5).selected).toEqual([5]);
  });

  it('select all', () => {
    expect(selectAll(3).selected).toEqual([0, 1, 2]);
    expect(selectAll(0).selected).toEqual([]);
  });

  it('keyboard focus movement', () => {
    let s = moveFocus(emptySelection, 1, 5);
    expect(s.selected).toEqual([0]);
    s = moveFocus(s, 2, 5, true);
    expect(s.selected).toEqual([0, 1, 2]);
    s = moveFocus(s, 10, 5);
    expect(s.selected).toEqual([4]);
    expect(moveFocus(s, -1, 0)).toEqual(emptySelection);
  });

  it('clamps after page count shrinks', () => {
    expect(clampSelection({ selected: [1, 4, 6], anchor: 6, focus: 4 }, 5)).toEqual({
      selected: [1, 4],
      anchor: null,
      focus: 4,
    });
  });
});

describe('invertSelection and selectByParity', () => {
  it('inverts the selection over the page count', () => {
    const s = invertSelection({ selected: [1, 3], anchor: 1, focus: 3 }, 5);
    expect(s).toEqual({ selected: [0, 2, 4], anchor: 0, focus: 4 });
  });

  it('inverting everything selected gives an empty selection', () => {
    expect(invertSelection(selectAll(3), 3)).toEqual(emptySelection);
  });

  it('inverting nothing selects every page', () => {
    expect(invertSelection(emptySelection, 2).selected).toEqual([0, 1]);
  });

  it('odd selects pages 1, 3, 5 (indices 0, 2, 4)', () => {
    expect(selectByParity(5, 'odd').selected).toEqual([0, 2, 4]);
  });

  it('even selects pages 2, 4 (indices 1, 3)', () => {
    expect(selectByParity(5, 'even').selected).toEqual([1, 3]);
  });

  it('parity of an empty document is empty', () => {
    expect(selectByParity(0, 'odd')).toEqual(emptySelection);
  });
});
