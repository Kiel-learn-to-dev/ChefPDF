import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGN_PREFS, readSignPrefs, writeSignPrefs } from './signPrefs';

describe('readSignPrefs', () => {
  it('gives the defaults for missing or broken prefs', () => {
    expect(readSignPrefs({})).toEqual(DEFAULT_SIGN_PREFS);
    expect(
      readSignPrefs({
        sign: { boxMm: { w: 'x', h: 9999 }, level: 'B-XX', digest: 'md5', certify: 'all' },
      }),
    ).toEqual(DEFAULT_SIGN_PREFS);
  });

  it('keeps valid values and the recent anchors without repeats', () => {
    const p = readSignPrefs({
      sign: {
        boxMm: { w: 60, h: 25 },
        level: 'B-LT',
        digest: 'sha384',
        certify: 'form-fill',
        anchors: ['GIÁM ĐỐC', 'giam doc', 42, 'NGƯỜI KÝ'],
      },
    });
    expect(p).toEqual({
      boxMm: { w: 60, h: 25 },
      level: 'B-LT',
      digest: 'sha384',
      certify: 'form-fill',
      anchors: ['GIÁM ĐỐC', 'NGƯỜI KÝ'],
    });
  });
});

describe('writeSignPrefs', () => {
  it('merges the patch and keeps other feature prefs', () => {
    const next = writeSignPrefs({ K: { dpi: 300 } }, { boxMm: { w: 40, h: 15 } });
    expect(next.K).toEqual({ dpi: 300 });
    expect(readSignPrefs(next).boxMm).toEqual({ w: 40, h: 15 });
  });

  it('stores no secret: only the plain choices', () => {
    const json = JSON.stringify(writeSignPrefs({}, { level: 'B-T' }));
    expect(json).not.toMatch(/pin|password/i);
  });
});
