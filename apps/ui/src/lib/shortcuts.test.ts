import { describe, expect, it } from 'vitest';
import { formatShortcut, matchShortcut } from './shortcuts';

const ev = (
  key: string,
  m: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {},
) => ({
  key,
  ctrlKey: !!m.ctrl,
  metaKey: !!m.meta,
  shiftKey: !!m.shift,
  altKey: !!m.alt,
});

describe('shortcuts', () => {
  it('formats for both platforms', () => {
    expect(formatShortcut('Mod+K', false)).toBe('Ctrl+K');
    expect(formatShortcut('Mod+Shift+S', true)).toBe('⌘⇧S');
    expect(formatShortcut('Mod++', false)).toBe('Ctrl++');
    expect(formatShortcut('Delete', false)).toBe('Del');
  });

  it('matches Mod per platform', () => {
    expect(matchShortcut(ev('k', { ctrl: true }), 'Mod+K', false)).toBe(true);
    expect(matchShortcut(ev('k', { meta: true }), 'Mod+K', true)).toBe(true);
    expect(matchShortcut(ev('k', { meta: true }), 'Mod+K', false)).toBe(false);
    expect(matchShortcut(ev('k'), 'Mod+K', false)).toBe(false);
  });

  it('checks shift for letters', () => {
    expect(matchShortcut(ev('S', { ctrl: true, shift: true }), 'Mod+Shift+S', false)).toBe(true);
    expect(matchShortcut(ev('s', { ctrl: true, shift: true }), 'Mod+S', false)).toBe(false);
  });

  it('ignores shift for symbol keys', () => {
    expect(matchShortcut(ev('+', { ctrl: true, shift: true }), 'Mod++', false)).toBe(true);
  });
});
