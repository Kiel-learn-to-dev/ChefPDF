/**
 * Native application menu. Edit/View use standard roles; app actions are minimal for v0.1.
 */
import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { Labels } from './labels';

export interface MenuActions {
  open(): void;
  about(): void;
  openLogs(): void;
  openDataDir(): void;
}

export function buildMenuTemplate(
  l: Labels,
  actions: MenuActions,
  opts: { platform: NodeJS.Platform; isDev: boolean },
): MenuItemConstructorOptions[] {
  const mac = opts.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
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
    });
  }

  template.push({
    label: l.file,
    submenu: [
      // The window handles Ctrl+O itself; registering it here as well opens two dialogs on
      // Linux and macOS. The menu only shows the shortcut.
      {
        label: l.open,
        accelerator: 'CmdOrCtrl+O',
        registerAccelerator: false,
        click: actions.open,
      },
      { type: 'separator' },
      mac ? { role: 'close', label: l.closeWindow } : { role: 'quit', label: l.quit },
    ],
  });

  template.push({
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
  });

  template.push({
    label: l.view,
    submenu: [
      ...(opts.isDev
        ? ([{ role: 'reload', label: l.reload }] satisfies MenuItemConstructorOptions[])
        : []),
      { role: 'toggleDevTools', label: l.devTools },
      { type: 'separator' },
      { role: 'resetZoom', label: l.resetZoom },
      { role: 'zoomIn', label: l.zoomIn },
      { role: 'zoomOut', label: l.zoomOut },
      { type: 'separator' },
      { role: 'togglefullscreen', label: l.fullscreen },
    ],
  });

  template.push({
    label: l.window,
    submenu: mac
      ? [
          { role: 'minimize', label: l.minimize },
          { role: 'zoom', label: l.zoom },
          { type: 'separator' },
          { role: 'front', label: l.front },
        ]
      : [
          { role: 'minimize', label: l.minimize },
          { role: 'close', label: l.closeWindow },
        ],
  });

  template.push({
    role: 'help',
    label: l.help,
    submenu: [
      ...(mac
        ? []
        : ([{ label: l.about, click: actions.about }] satisfies MenuItemConstructorOptions[])),
      { label: l.openLogs, click: actions.openLogs },
      { label: l.openData, click: actions.openDataDir },
    ],
  });

  return template;
}

export function installMenu(
  l: Labels,
  actions: MenuActions,
  opts: { platform: NodeJS.Platform; isDev: boolean },
): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(l, actions, opts)));
}
