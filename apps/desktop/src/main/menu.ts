/** Native menu: none on Windows and Linux; a minimal app menu and Edit on macOS (1.2). */
import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Labels } from './labels';

export interface MenuActions {
  about(): void;
}

/**
 * Menu bar (1.2). Windows and Linux have none: their keys (Ctrl+O, zoom, F11) belong to the window
 * and the app. macOS keeps a minimal menu: the Edit items are what Cmd+C, Cmd+V, Cmd+X, Cmd+A and
 * Cmd+Z use there.
 */
export function installMenu(
  l: Labels,
  actions: MenuActions,
  opts: { platform: NodeJS.Platform; isDev: boolean },
): void {
  if (opts.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(l, actions)));
}

/** The macOS menu of 1.2: the app menu and Edit only. */
export function macMenuTemplate(l: Labels, actions: MenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: l.appName,
      submenu: [
        { label: l.about, click: actions.about },
        { type: 'separator' },
        { role: 'services', label: l.services },
        { type: 'separator' },
        { role: 'hide', label: l.hide },
        { role: 'hideOthers', label: l.hideOthers },
        { role: 'unhide', label: l.unhide },
        { type: 'separator' },
        { role: 'quit', label: l.quit },
      ],
    },
    {
      label: l.edit,
      submenu: [
        { role: 'undo', label: l.undo },
        { role: 'redo', label: l.redo },
        { type: 'separator' },
        { role: 'cut', label: l.cut },
        { role: 'copy', label: l.copy },
        { role: 'paste', label: l.paste },
        { role: 'selectAll', label: l.selectAll },
      ],
    },
  ];
}
