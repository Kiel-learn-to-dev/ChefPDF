import { beforeEach, describe, expect, it } from 'vitest';
import { useDocs } from './documents';

/** The About tab (1.2) is open over the start screen or a document until another tab is chosen. */
describe('About tab state', () => {
  beforeEach(() => {
    useDocs.setState({ docs: [], activeId: null, aboutOpen: false });
  });

  it('opens over the current tab without changing which document is active', () => {
    useDocs.setState({ activeId: 'doc-a' });
    useDocs.getState().openAbout();
    expect(useDocs.getState().aboutOpen).toBe(true);
    expect(useDocs.getState().activeId).toBe('doc-a');
  });

  it('is left when the start tab or a document is activated, even the one already active', () => {
    useDocs.setState({ activeId: 'doc-a', aboutOpen: true });
    useDocs.getState().activate('doc-a');
    expect(useDocs.getState().aboutOpen).toBe(false);

    useDocs.getState().openAbout();
    useDocs.getState().activate(null);
    expect(useDocs.getState().aboutOpen).toBe(false);
  });

  it('is left when a document is added (opened)', () => {
    useDocs.getState().openAbout();
    useDocs.getState().add({
      id: 'doc-b',
      name: 'b.pdf',
      state: {} as never,
      info: {} as never,
      password: undefined,
    } as never);
    expect(useDocs.getState().aboutOpen).toBe(false);
    expect(useDocs.getState().activeId).toBe('doc-b');
  });
});
