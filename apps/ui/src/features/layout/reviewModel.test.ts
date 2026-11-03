import { expect, it } from 'vitest';
import { regionStyle, reviewedBlock, setChange, textOf } from './reviewModel';

it('keeps one correction per block and retains corrections to other pages', () => {
  const previous = [
    { pageIndex: 0, blockIndex: 1, kind: 'heading' as const },
    { pageIndex: 1, blockIndex: 1, kind: 'footer' as const },
  ];
  expect(setChange(previous, { pageIndex: 0, blockIndex: 1, kind: 'paragraph' })).toEqual([
    previous[1],
    { pageIndex: 0, blockIndex: 1, kind: 'paragraph' },
  ]);
  expect(textOf({ kind: 'paragraph', bbox: [], runs: [{ text: 'Xin ' }, { text: 'chào' }] })).toBe(
    'Xin chào',
  );
});

it('builds the result preview from reviewed text and block type', () => {
  const block = { kind: 'heading', bbox: [0, 0, 100, 20], level: 2, runs: [{ text: 'Draft' }] };
  expect(
    reviewedBlock(block, [{ pageIndex: 3, blockIndex: 0, kind: 'paragraph', text: 'Final' }], 3, 0),
  ).toEqual({
    kind: 'paragraph',
    level: 2,
    text: 'Final',
  });
  expect(reviewedBlock(block, [], 3, 0)).toEqual({ kind: 'heading', level: 2, text: 'Draft' });
});

it('maps a block from page points to the displayed page', () => {
  const block = { kind: 'paragraph', bbox: [20, 40, 100, 80] };
  expect(regionStyle({ index: 0, width: 200, height: 400, blocks: [block] }, block)).toEqual({
    left: '10%',
    top: '10%',
    width: '40%',
    height: '10%',
  });
});
