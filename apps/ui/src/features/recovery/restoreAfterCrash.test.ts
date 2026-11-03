import { describe, expect, it, vi } from 'vitest';
import { restoreAfterCrash } from './restoreAfterCrash';

describe('restoreAfterCrash', () => {
  it('restores the existing sessions and retains failed sessions for retry', async () => {
    const restore = vi.fn(async (id: string) => {
      if (id === 'failed') throw new Error('unavailable');
      return { id };
    });
    const apply = vi.fn();
    const reportError = vi.fn();
    const pending = await restoreAfterCrash(
      ['first', 'failed', 'last'],
      restore,
      apply,
      reportError,
    );
    expect(restore.mock.calls.map(([id]) => id)).toEqual(['first', 'failed', 'last']);
    expect(apply.mock.calls.map(([id]) => id)).toEqual(['first', 'last']);
    expect(pending).toEqual(['failed']);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
