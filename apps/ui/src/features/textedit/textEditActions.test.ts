import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/actions', () => ({
  runDocOp: vi.fn().mockResolvedValue(null),
  errorMessage: vi.fn(),
  showError: vi.fn(),
}));

import { applyParagraph, applyParagraphStyle } from './textEditActions';
import { useTextEdit } from './textEditState';

describe('paragraph operation failure', () => {
  beforeEach(() => {
    useTextEdit.getState().openParagraph({
      pageIndex: 0,
      paragraphId: 'paragraph',
      original: 'Original',
      text: 'Changed',
    });
  });

  it.each([applyParagraph, applyParagraphStyle])(
    'lets the user retry after an operation fails',
    async (apply) => {
      expect(await apply('document')).toBe(false);
      expect(useTextEdit.getState().paraEditor).toMatchObject({
        text: 'Changed',
        applying: false,
      });
    },
  );
});
