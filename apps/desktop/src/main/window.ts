/**
 * Main window: secure webPreferences, navigation lockdown, persisted geometry.
 */
import { BrowserWindow, nativeTheme, screen, shell } from 'electron';
import { APP_HOST, APP_SCHEME, APP_VERSION_ARG } from '../shared/ipc';
import {
  DEFAULT_SIZE,
  MIN_SIZE,
  fitToDisplays,
  loadWindowState,
  saveWindowState,
} from './windowState';

export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/`;

/** `scheme://host` of a URL; works for custom schemes, whose WHATWG `origin` is "null". */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export interface CreateWindowOptions {
  preloadPath: string;
  statePath: string;
  appVersion: string;
  devServerUrl?: string | undefined;
  title: string;
  log(message: string): void;
}

export function trustedOrigins(devServerUrl?: string): Set<string> {
  const set = new Set<string>([`${APP_SCHEME}://${APP_HOST}`]);
  if (devServerUrl) {
    const o = originOf(devServerUrl);
    if (o) set.add(o);
  }
  return set;
}

export function createMainWindow(o: CreateWindowOptions): BrowserWindow {
  const state = loadWindowState(o.statePath);
  const bounds = fitToDisplays(
    state.bounds,
    screen.getAllDisplays().map((d) => d.workArea),
  );

  const win = new BrowserWindow({
    ...(bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: o.title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#ffffff',
    webPreferences: {
      preload: o.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      additionalArguments: [`${APP_VERSION_ARG}${o.appVersion}`],
    },
  });

  lockDownNavigation(win, trustedOrigins(o.devServerUrl));
  persistGeometry(win, o.statePath);

  win.once('ready-to-show', () => {
    o.log(`startup: window ready-to-show at ${Math.round(process.uptime() * 1000)} ms`);
    if (state.isMaximized) win.maximize();
    win.show();
  });

  const entry = o.devServerUrl ?? APP_ENTRY_URL;
  let fellBack = false;
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
    o.log(`load failed (${code} ${desc}) for ${url}`);
    if (!fellBack && url.startsWith(o.devServerUrl ?? '\0')) {
      fellBack = true;
      void win.loadURL(APP_ENTRY_URL);
    }
    if (!win.isVisible()) win.show();
  });
  void win.loadURL(entry).catch(() => undefined);
  return win;
}

function lockDownNavigation(win: BrowserWindow, allowed: Set<string>): void {
  const openExternally = (url: string): void => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const origin = originOf(url);
    if (origin && allowed.has(origin)) return;
    event.preventDefault();
    openExternally(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    const origin = originOf(url);
    if (!origin || !allowed.has(origin)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function persistGeometry(win: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    saveWindowState(file, { bounds: win.getNormalBounds(), isMaximized: win.isMaximized() });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', save);
}
