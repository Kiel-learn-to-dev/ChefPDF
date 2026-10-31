/**
 * Keyboard shortcut helpers. Shortcuts are written like "Mod+Shift+S", where
 * Mod = Cmd on macOS and Ctrl elsewhere.
 */

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Delete: 'Del',
  Escape: 'Esc',
  ' ': 'Space',
  '=': '+',
};

export function formatShortcut(shortcut: string, mac = isMac()): string {
  const parts = shortcut.split('+').map((p) => (p === '' ? '+' : p));
  // "Mod++" splits into ['Mod', '', ''] -> handle '+' key
  const keys = shortcut.endsWith('++') ? [...shortcut.slice(0, -2).split('+'), '+'] : parts;
  const shown = keys.map((k) => {
    if (mac && MAC_SYMBOLS[k]) return MAC_SYMBOLS[k];
    if (k === 'Mod') return 'Ctrl';
    return KEY_NAMES[k] ?? (k.length === 1 ? k.toUpperCase() : k);
  });
  return mac ? shown.join('') : shown.join('+');
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Does a keyboard event match "Mod+Shift+S"-style shortcut? */
export function matchShortcut(e: KeyLike, shortcut: string, mac = isMac()): boolean {
  const keys = shortcut.endsWith('++')
    ? [...shortcut.slice(0, -2).split('+'), '+']
    : shortcut.split('+');
  const key = keys[keys.length - 1]!;
  const mods = new Set(keys.slice(0, -1));
  const wantMod = mods.has('Mod');
  const modPressed = mac ? e.metaKey : e.ctrlKey;
  if (wantMod !== modPressed) return false;
  if (!mac && !wantMod && e.ctrlKey !== mods.has('Ctrl')) return false;
  if (mac && e.ctrlKey !== mods.has('Ctrl')) return false;
  if (e.altKey !== mods.has('Alt')) return false;
  const shiftMatters = key.length !== 1 || /[a-z0-9]/i.test(key);
  if (shiftMatters && e.shiftKey !== mods.has('Shift')) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/** True when the event target is a text-editing element (shortcuts like Delete must not fire). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range'].includes(type);
  }
  return false;
}
