import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/actions', () => ({
  runDocOp: vi.fn().mockResolvedValue(null),
  errorMessage: vi.fn(),
  showError: vi.fn(),
}));
vi.mock('../../lib/rpc', () => ({ runOp: vi.fn() }));

import { runDocOp } from '../../app/actions';
import { commitSession, previewNotes } from './textEditActions';
import { useTextEdit } from './textEditState';

describe('paragraph session commit', () => {
  beforeEach(() => {
    useTextEdit.getState().closeSession();
    useTextEdit.getState().openSession({
      pageIndex: 0,
      paragraphId: 'P0:aaaaaaaaaaaa:0',
      original: 'Original',
      fontSize: 10,
    });
    useTextEdit.getState().patchSession({ text: 'Changed' });
  });

  it('keeps the session open when the write fails, so the typed text is not lost', async () => {
    expect(await commitSession('document')).toBe(false);
    expect(useTextEdit.getState().session).toMatchObject({ text: 'Changed', committing: false });
    expect(vi.mocked(runDocOp)).toHaveBeenCalled();
  });

  it('only closes the session when the text is unchanged', async () => {
    useTextEdit.getState().patchSession({ text: 'Original' });
    expect(await commitSession('document')).toBe(true);
    expect(useTextEdit.getState().session).toBeNull();
    expect(vi.mocked(runDocOp)).not.toHaveBeenCalled();
  });
});

describe('preview notes', () => {
  it('says which font takes over, and what overflows or overlaps', () => {
    const notes = previewNotes({
      fontFrom: 'BeVietnamPro-Regular',
      fontTo: 'BeVietnamPro-Regular',
      missing: ['ư'],
      overflow: 4,
      overlapsBlockIds: ['B1'],
    });
    expect(notes.map((n) => n.tone)).toEqual(['warn', 'warn', 'warn']);
    expect(notes[0]?.text).toContain('BeVietnamPro-Regular');
  });

  it('reports missing characters only when no font takes over', () => {
    const notes = previewNotes({ fontFrom: 'F', fontTo: null, missing: ['ư'], overflow: 0 });
    expect(notes).toEqual([expect.objectContaining({ tone: 'error' })]);
  });

  it('gives no notes when the original font writes everything', () => {
    expect(previewNotes({ fontFrom: 'F', fontTo: null, missing: [], overflow: 0 })).toEqual([]);
  });
});
