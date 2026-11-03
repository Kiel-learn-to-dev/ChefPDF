import { expect, it } from 'vitest';
import { outputSizeFromMm } from './cropSizing';

it('requires both millimeter dimensions and converts them using source PPI', () => {
  expect(outputSizeFromMm('210', '297', 300)).toEqual({ valid: true, outSize: [2480, 3508] });
  expect(outputSizeFromMm('210', '', 300).valid).toBe(false);
  expect(outputSizeFromMm('', '297', 300).valid).toBe(false);
  expect(outputSizeFromMm('', '', 300)).toEqual({ valid: true, outSize: undefined });
});

it('rejects non-finite, non-positive and oversized output dimensions', () => {
  expect(outputSizeFromMm('NaN', '100', 300).valid).toBe(false);
  expect(outputSizeFromMm('0', '100', 300).valid).toBe(false);
  expect(outputSizeFromMm('100000', '100000', 300).valid).toBe(false);
});
