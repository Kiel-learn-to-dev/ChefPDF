import { describe, expect, it } from 'vitest';
import {
  createIssue,
  createParams,
  DEFAULT_CREATE_FORM,
  isChanged,
  parseOptions,
  readFormFields,
} from './formsModel';

const placement = { pageIndex: 2, rect: [30, 40, 150, 70] };

describe('forms model', () => {
  it('parses and de-duplicates choices from commas and new lines', () => {
    expect(parseOptions('Có, Không\nKhác, Có')).toEqual(['Có', 'Không', 'Khác']);
  });

  it('creates normal fields and a radio group from one drawn rectangle', () => {
    expect(
      createParams(
        { ...DEFAULT_CREATE_FORM, kind: 'text', name: 'thongtin.hoten', required: true },
        placement,
      ),
    ).toEqual([
      {
        kind: 'text',
        pageIndex: 2,
        rect: [30, 40, 150, 70],
        name: 'thongtin.hoten',
        required: true,
      },
    ]);
    expect(
      createParams(
        { ...DEFAULT_CREATE_FORM, kind: 'radio', name: 'gioitinh', optionsText: 'Nam, Nữ' },
        placement,
      ),
    ).toEqual([
      {
        kind: 'radio',
        pageIndex: 2,
        rect: [30, 40, 90, 70],
        name: 'gioitinh',
        required: false,
        exportValue: 'Nam',
      },
      {
        kind: 'radio',
        pageIndex: 2,
        rect: [90, 40, 150, 70],
        name: 'gioitinh',
        required: false,
        exportValue: 'Nữ',
      },
    ]);
  });

  it('requires choices for dropdowns and enough width for each radio option', () => {
    expect(createIssue({ ...DEFAULT_CREATE_FORM, kind: 'dropdown', name: 'tinh' }, placement)).toBe(
      'options',
    );
    expect(
      createIssue(
        { ...DEFAULT_CREATE_FORM, kind: 'radio', name: 'chon', optionsText: 'A, B, C' },
        { pageIndex: 0, rect: [10, 10, 40, 30] },
      ),
    ).toBe('radioSize');
  });

  it('requires a positive max length for comb fields and a valid name', () => {
    expect(createIssue({ ...DEFAULT_CREATE_FORM, kind: 'comb', name: 'code' }, placement)).toBe(
      'maxLen',
    );
    expect(createIssue({ ...DEFAULT_CREATE_FORM, name: 'not a name' }, placement)).toBe('name');
    expect(
      createParams(
        { ...DEFAULT_CREATE_FORM, kind: 'comb', name: 'code', maxLenText: '8' },
        placement,
      ),
    ).toMatchObject([{ kind: 'comb', maxLen: 8 }]);
  });

  it('reads fields and capabilities defensively', () => {
    expect(
      readFormFields({
        fields: [{ name: 'x', type: 'text' }, null, {}],
        xfa: true,
        needAppearances: true,
      }),
    ).toMatchObject({ fields: [{ name: 'x', type: 'text' }], xfa: true, needAppearances: true });
    expect(readFormFields(null)).toEqual({ fields: [], xfa: false, needAppearances: false });
    expect(isChanged({ a: 'text' })).toBe(true);
    expect(isChanged({})).toBe(false);
  });
});
