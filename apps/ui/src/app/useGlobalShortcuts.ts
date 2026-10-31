import { useEffect, useRef } from 'react';
import { isEditableTarget, matchShortcut } from '../lib/shortcuts';
import type { Command } from './commands';
import { useUi } from './state/ui';

/** Dispatch keyboard shortcuts of registered commands. */
export function useGlobalShortcuts(commands: Command[]) {
  const ref = useRef(commands);
  useEffect(() => {
    ref.current = commands;
  }, [commands]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useUi.getState().presenting) return;
      const editable = isEditableTarget(e.target);
      // While a modal dialog is open only the palette toggle is global.
      const modalOpen = !!document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"]',
      );
      for (const c of ref.current) {
        const keys = [c.shortcut, ...(c.altShortcuts ?? [])].filter((k): k is string => !!k);
        if (!keys.some((k) => matchShortcut(e, k))) continue;
        if (editable && !c.inInputs) return;
        if (modalOpen && c.id !== 'app.palette') return;
        if (!c.enabled) continue;
        e.preventDefault();
        c.run();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
