import { describe, expect, it, vi } from 'vitest';
import { addFieldsSequentially } from './formsOperations';

const fields = ['A', 'B', 'C'].map((exportValue) => ({
  kind: 'radio' as const,
  pageIndex: 0,
  rect: [0, 0, 30, 20],
  name: 'choice',
  exportValue,
}));

describe('radio field creation sequence', () => {
  it('stops at the first failure and removes the partially created group', async () => {
    let call = 0;
    const add = vi.fn(async () => call++ === 0);
    const remove = vi.fn(async () => true);
    const result = await addFieldsSequentially(fields, add, remove);
    expect(result).toEqual({ success: false, completed: 1, rolledBack: true });
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith('choice');
  });

  it('reports when rollback also fails so the caller can warn about remaining partial data', async () => {
    const result = await addFieldsSequentially(
      fields,
      async () => false,
      async () => false,
    );
    expect(result).toEqual({ success: false, completed: 0, rolledBack: false });
  });
});
