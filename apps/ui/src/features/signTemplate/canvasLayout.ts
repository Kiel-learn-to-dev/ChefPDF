/**
 * APPROXIMATE layout for the live preview of a signature template. Pure maths, no drawing.
 *
 * The real look is drawn by the core (appearance.py); this is a quick preview while editing.
 * Text width is estimated from the character count, so the shrink steps can differ slightly
 * from the core. Use "Xem thử bằng lõi" (renderTemplateProof) for the exact result.
 *
 * Constants follow appearance.py: LEAD = 1.2 em line advance, SHRINK_STEP = 0.25 pt.
 */
import type { SignatureTemplate } from '@chef/contracts';

export const LEAD = 1.2;
export const SHRINK_STEP = 0.25;

/** Average glyph width in em: a rough value for Be Vietnam Pro; bold is wider. */
export function approxTextWidth(text: string, sizePt: number, bold: boolean): number {
  return [...text].length * sizePt * (bold ? 0.6 : 0.54);
}

export interface TextRow {
  text: string;
  /** Requested size of the line (before shrinking). */
  fontSize: number;
}

export interface PlacedRow {
  text: string;
  /** Size after auto-shrink. */
  fontSize: number;
  x: number;
  /** Baseline in box coordinates (top-left origin, points). */
  y: number;
  width: number;
  /** True when even the minimum size does not fit (the core would clip or wrap). */
  overflow: boolean;
}

export interface BoxLayout {
  rows: PlacedRow[];
  /** Text area inside the padding. */
  area: { x: number; y: number; width: number; height: number };
  /** True when any row was shrunk. */
  shrunk: boolean;
  /** True when the block still does not fit the box. */
  overflow: boolean;
}

/** Shrinks every size by SHRINK_STEP until the block fits the height or the floor is reached. */
function fitHeight(rows: TextRow[], sizes: number[], floor: number, maxHeight: number): number[] {
  let scale = 0;
  const heightOf = (current: number[]) => current.reduce((sum, size) => sum + size * LEAD, 0);
  const apply = (s: number) => rows.map((r, i) => Math.max(floor, +(sizes[i]! - s).toFixed(4)));
  let current = apply(scale);
  while (heightOf(current) > maxHeight && current.some((s) => s > floor)) {
    scale += SHRINK_STEP;
    current = apply(scale);
  }
  return current;
}

/**
 * Lays out the text rows of a box (w x h points). With autoShrink the rows shrink to fit the
 * width (each row) and the height (all rows together), never below minFontSize.
 */
export function layoutBox(
  box: { width: number; height: number },
  template: Pick<
    SignatureTemplate,
    'padding' | 'fontSize' | 'minFontSize' | 'autoShrink' | 'bold' | 'align' | 'valign'
  >,
  rows: TextRow[],
): BoxLayout {
  const pad = template.padding ?? 4;
  const area = {
    x: pad,
    y: pad,
    width: Math.max(0, box.width - 2 * pad),
    height: Math.max(0, box.height - 2 * pad),
  };
  const bold = template.bold ?? false;
  const floor = template.minFontSize ?? 5;
  const auto = template.autoShrink ?? true;

  let sizes = rows.map((r) => r.fontSize);
  if (auto) {
    // Width first, row by row; then the height of the whole block.
    sizes = rows.map((r, i) => {
      let size = sizes[i]!;
      while (size > floor && approxTextWidth(r.text, size, bold) > area.width) {
        size = Math.max(floor, +(size - SHRINK_STEP).toFixed(4));
      }
      return size;
    });
    sizes = fitHeight(rows, sizes, floor, area.height);
  }
  const shrunk = sizes.some((s, i) => s < rows[i]!.fontSize);

  const blockHeight = sizes.reduce((sum, s) => sum + s * LEAD, 0);
  let top: number;
  if (template.valign === 'bottom') top = area.y + area.height - blockHeight;
  else if (template.valign === 'top') top = area.y;
  else top = area.y + (area.height - blockHeight) / 2;

  let y = top;
  const placed: PlacedRow[] = rows.map((r, i) => {
    const size = sizes[i]!;
    const width = approxTextWidth(r.text, size, bold);
    // Without auto-shrink a row is simply too wide; with it, only the floor size can overflow.
    const overflow = width > area.width && (!auto || size <= floor);
    const x =
      template.align === 'center'
        ? area.x + (area.width - width) / 2
        : template.align === 'right'
          ? area.x + area.width - width
          : area.x;
    // The baseline sits one line advance below the block top, as in the core.
    const row: PlacedRow = { text: r.text, fontSize: size, x, y: y + size * LEAD, width, overflow };
    y += size * LEAD;
    return row;
  });

  const overflow = y > area.y + area.height + 0.01 || placed.some((p) => p.overflow);
  return { rows: placed, area, shrunk, overflow };
}
