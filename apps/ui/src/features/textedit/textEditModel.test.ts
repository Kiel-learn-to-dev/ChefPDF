import { describe, expect, it } from 'vitest';
import { hitLine, type TextLine } from './textEditModel';

function line(id: string, bbox: number[], extra: Partial<TextLine> = {}): TextLine {
  return {
    id,
    pageIndex: 0,
    text: id,
    bbox,
    fontName: 'F',
    fontSize: 10,
    bold: false,
    italic: false,
    canEncodeAny: true,
    paragraphId: 'P0:aaaaaaaaaaaa:0',
    editable: true,
    artifact: false,
    ...extra,
  };
}

describe('hitLine', () => {
  it('returns the smallest editable line under the point', () => {
    const big = line('big', [0, 0, 200, 100]);
    const small = line('small', [50, 40, 80, 60]);
    expect(hitLine([big, small], 60, 50)?.id).toBe('small');
    expect(hitLine([big, small], 150, 90)?.id).toBe('big');
  });

  it('skips lines that cannot be edited and artifacts', () => {
    const locked = line('locked', [0, 0, 100, 100], { editable: false });
    const artifact = line('artifact', [0, 0, 100, 100], { artifact: true });
    expect(hitLine([locked, artifact], 10, 10)).toBeNull();
  });

  it('is null outside every line', () => {
    expect(hitLine([line('a', [0, 0, 10, 10])], 50, 50)).toBeNull();
  });
});
