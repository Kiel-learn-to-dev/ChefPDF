/**
 * Multi-selection logic for page grids (click, Shift+click, Ctrl/Cmd+click).
 * Pure and framework-free so it can be unit tested.
 */

export interface Selection {
  /** Selected 0-based indices, sorted ascending. */
  selected: number[];
  /** Anchor for Shift ranges. */
  anchor: number | null;
  /** Item with keyboard focus. */
  focus: number | null;
}

export const emptySelection: Selection = { selected: [], anchor: null, focus: null };

export interface ClickModifiers {
  shift?: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle?: boolean;
}

function sortUnique(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function range(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** Apply a click on `index` with modifiers. */
export function clickSelect(sel: Selection, index: number, mods: ClickModifiers = {}): Selection {
  if (mods.shift && sel.anchor !== null) {
    const span = range(sel.anchor, index);
    const selected = mods.toggle ? sortUnique([...sel.selected, ...span]) : span;
    return { selected, anchor: sel.anchor, focus: index };
  }
  if (mods.toggle) {
    const has = sel.selected.includes(index);
    const selected = has
      ? sel.selected.filter((i) => i !== index)
      : sortUnique([...sel.selected, index]);
    return { selected, anchor: index, focus: index };
  }
  return { selected: [index], anchor: index, focus: index };
}

/** Click that should keep a multi-selection when the item is already selected (e.g. before a drag or context menu). */
export function pressSelect(sel: Selection, index: number, mods: ClickModifiers = {}): Selection {
  if (!mods.shift && !mods.toggle && sel.selected.includes(index)) {
    return { ...sel, focus: index };
  }
  return clickSelect(sel, index, mods);
}

export function selectAll(count: number): Selection {
  return {
    selected: count > 0 ? range(0, count - 1) : [],
    anchor: count > 0 ? 0 : null,
    focus: count > 0 ? 0 : null,
  };
}

/** Move keyboard focus by `delta` (e.g. ±1 or ±columns); Shift extends the selection. */
export function moveFocus(sel: Selection, delta: number, count: number, extend = false): Selection {
  if (count === 0) return emptySelection;
  const from = sel.focus ?? (delta > 0 ? -1 : count);
  const next = Math.min(count - 1, Math.max(0, from + delta));
  if (extend) {
    const anchor = sel.anchor ?? next;
    return { selected: range(anchor, next), anchor, focus: next };
  }
  return { selected: [next], anchor: next, focus: next };
}

/** Keep a selection valid after the page count changes. */
export function clampSelection(sel: Selection, count: number): Selection {
  const inRange = (i: number | null) => (i !== null && i < count ? i : null);
  return {
    selected: sel.selected.filter((i) => i < count),
    anchor: inRange(sel.anchor),
    focus: inRange(sel.focus),
  };
}

/** Every page except the selected ones (menu: Đảo chọn). Focus and anchor move to the new selection. */
export function invertSelection(sel: Selection, count: number): Selection {
  const picked = new Set(sel.selected);
  const selected = Array.from({ length: count }, (_, i) => i).filter((i) => !picked.has(i));
  return {
    selected,
    anchor: selected[0] ?? null,
    focus: selected[selected.length - 1] ?? null,
  };
}

/**
 * Select the odd- or even-numbered pages (1-based page numbers, so odd pages are the
 * even 0-based indices). Used by the menu: Chọn trang lẻ / Chọn trang chẵn.
 */
export function selectByParity(count: number, parity: 'odd' | 'even'): Selection {
  const selected = Array.from({ length: count }, (_, i) => i).filter(
    (i) => (i % 2 === 0) === (parity === 'odd'),
  );
  return {
    selected,
    anchor: selected[0] ?? null,
    focus: selected[selected.length - 1] ?? null,
  };
}
