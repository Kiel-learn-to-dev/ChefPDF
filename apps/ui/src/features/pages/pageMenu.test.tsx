import { describe, expect, it, vi } from 'vitest';
import { i18n } from '../../i18n';
import type { MenuEntry } from '../../components/Menu';
import { menuTargetCount, pageMenuEntries, type PageMenuInput } from './pageMenu';

// The menu only builds entries; the actions are not run here.
vi.mock('./pageActions', () => ({
  compressPagesInNewTab: vi.fn(),
  createPdfFromPages: vi.fn(),
  deletePages: vi.fn(),
  duplicatePages: vi.fn(),
  imagesFromPages: vi.fn(),
  insertBlank: vi.fn(),
  insertClipboardImage: vi.fn(),
  invertPageSelection: vi.fn(),
  openPageInViewer: vi.fn(),
  rotatePages: vi.fn(),
  selectAll: vi.fn(),
  selectParityPages: vi.fn(),
  stampPages: vi.fn(),
}));

const base: PageMenuInput = {
  docId: 'd1',
  pageIndex: 0,
  selected: [0],
  pageCount: 5,
  signed: false,
};

function items(input: Partial<PageMenuInput>): Map<string, MenuEntry & { type?: string }> {
  const map = new Map<string, MenuEntry & { type?: string }>();
  for (const e of pageMenuEntries({ ...base, ...input })) map.set(e.id, e);
  return map;
}

/** disabled flag of an item entry (separators have none). */
function disabled(map: Map<string, MenuEntry & { type?: string }>, id: string): boolean {
  const e = map.get(id);
  if (!e || e.type === 'separator' || e.type === 'label') throw new Error(`no item ${id}`);
  return !!e.disabled;
}

describe('page menu', () => {
  it('the target count is the selection when the page is in it, else one page', () => {
    expect(menuTargetCount({ pageIndex: 3, selected: [1, 3, 4] })).toBe(3);
    expect(menuTargetCount({ pageIndex: 2, selected: [1, 3, 4] })).toBe(1);
  });

  it('the create-PDF entry comes first and shows the number of selected pages', () => {
    const entries = pageMenuEntries({ ...base, pageIndex: 3, selected: [1, 3, 4] });
    expect(entries[0]?.id).toBe('createPdf');
    expect(entries[0]).toMatchObject({
      label: i18n.t('pageMenu.createPdf', { count: 3 }),
    });
    expect(String((entries[0] as { label: string }).label)).toContain('3');
  });

  it('the old extract entry is gone: create-PDF replaces it', () => {
    const ids = pageMenuEntries(base).map((e) => e.id);
    expect(ids).not.toContain('ext');
    expect(ids).toContain('createPdf');
  });

  it('a signed file disables what rewrites it but keeps reading and new-file actions', () => {
    const map = items({ signed: true });
    for (const id of ['rl', 'rr', 'dup', 'stamp', 'blankBefore', 'file', 'img', 'paste', 'del']) {
      expect(disabled(map, id), id).toBe(true);
    }
    for (const id of ['createPdf', 'open', 'compress', 'toImages', 'selAll', 'selOdd']) {
      expect(disabled(map, id), id).toBe(false);
    }
  });

  it('an unsigned file enables the rewriting actions', () => {
    const map = items({});
    for (const id of ['rl', 'rr', 'dup', 'stamp', 'blankAfter', 'del']) {
      expect(disabled(map, id), id).toBe(false);
    }
  });

  it('with every page selected, select-all and invert are disabled and delete is too', () => {
    const map = items({ selected: [0, 1, 2, 3, 4], pageIndex: 2 });
    expect(disabled(map, 'selAll')).toBe(true);
    expect(disabled(map, 'selInvert')).toBe(true);
    expect(disabled(map, 'del')).toBe(true);
    expect(disabled(map, 'selOdd')).toBe(false);
  });

  it('with part of the pages selected, invert and select-all are enabled', () => {
    const map = items({ selected: [0, 1], pageIndex: 0 });
    expect(disabled(map, 'selAll')).toBe(false);
    expect(disabled(map, 'selInvert')).toBe(false);
    expect(disabled(map, 'del')).toBe(false);
  });

  it('the delete label counts the targeted pages', () => {
    const map = items({ selected: [1, 2], pageIndex: 2 });
    expect(map.get('del')).toMatchObject({ label: i18n.t('pages.deleteN', { count: 2 }) });
  });
});
