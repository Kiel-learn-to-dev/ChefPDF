/**
 * Electron main entry: wires window, menu, protocols, sidecar, settings and OS file opening.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import type { ChefEvent, RpcNotification, RpcNotifications, Settings } from '@chef/contracts';
import { APP_SCHEME, FILE_SCHEME, IpcChannels } from '../shared/ipc';
import { PathAllowlist } from './allowlist';
import { buildCsp } from './csp';
import { registerIpc } from './ipc';
import { labelsFor } from './labels';
import { RotatingLog } from './logger';
import { installMenu } from './menu';
import { ChefLibrary, secretKeyStore } from './library';
import { captureClipboardPng } from './clipboardImage';
import { CaptureService, type NetIface } from './capture';
import { OpenFilesController, argvSkipCount, parseFileArgs } from './openFiles';
import { repoRootFrom, resolveBundledFonts, resolveUi } from './paths';
import { createAppHandler, createFileHandler, privilegedSchemes } from './protocol';
import { SecretStore } from './secrets';
import { SettingsStore } from './settings';
import { SidecarManager, resolveCoreCommand, type CoreStatus } from './sidecar';
import { createMainWindow, trustedOrigins } from './window';
import { createWeb2PdfHandler } from './web2pdf';
import { renderToPdf } from './web2pdfRender';

const APP_TITLE = 'Chef PDF';
const isDev = !app.isPackaged;
const devServerUrl = isDev ? process.env.CHEF_DEV_SERVER_URL || undefined : undefined;

// --- Paths (must be settled before the single-instance lock, which keys on userData) ---
app.setName(APP_TITLE);
if (process.env.CHEF_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.CHEF_USER_DATA_DIR));
} else if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), `${APP_TITLE} (dev)`));
}
const userData = app.getPath('userData');
const logsDir = path.join(userData, 'logs');
const sessionsDir = path.join(userData, 'sessions');
const cacheDir = path.join(userData, 'cache');
for (const dir of [logsDir, sessionsDir, cacheDir]) fs.mkdirSync(dir, { recursive: true });

const mainLog = new RotatingLog(path.join(logsDir, 'main.log'));
const log = (message: string): void => {
  mainLog.line(message);
  if (process.env.CHEF_STARTUP_TRACE) console.log(`[chef] ${message}`);
};
process.on('uncaughtException', (err) => log(`uncaughtException: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${String(err)}`));

// Sandbox every renderer. Skipped only when Chromium's OS sandbox is explicitly disabled with
// --no-sandbox (CI containers running as root), where forcing it would crash child processes.
// Windows still get `sandbox: true` in their webPreferences either way.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
protocol.registerSchemesAsPrivileged(privilegedSchemes);

const allowlist = new PathAllowlist([sessionsDir, cacheDir]);
const openFiles = new OpenFilesController((file) => allowlist.addFile(file));
const skip = argvSkipCount(app.isPackaged, Boolean(process.defaultApp));

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarManager | null = null;
let coreStatus: CoreStatus = 'starting';

function broadcast(event: ChefEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IpcChannels.event, event);
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock({ argv: process.argv, cwd: process.cwd() });
if (!gotLock) {
  app.quit();
} else {
  // Files passed at launch.
  openFiles.add(parseFileArgs(process.argv, { cwd: process.cwd(), skip }));

  // macOS delivers "Open with" / double-click via open-file, possibly before `ready`.
  app.on('open-file', (event, file) => {
    event.preventDefault();
    openFiles.add([path.resolve(file)]);
    if (app.isReady() && !mainWindow) openMainWindow();
    else focusMainWindow();
  });

  app.on('second-instance', (_event, argv, cwd, additionalData) => {
    const data = (additionalData ?? {}) as { argv?: unknown; cwd?: unknown };
    const args =
      Array.isArray(data.argv) && data.argv.every((a) => typeof a === 'string') ? data.argv : argv;
    const dir = typeof data.cwd === 'string' ? data.cwd : cwd;
    openFiles.add(parseFileArgs(args as string[], { cwd: dir, skip }));
    if (!mainWindow) openMainWindow();
    else focusMainWindow();
  });

  void app.whenReady().then(onReady);
}

let capture: CaptureService | null = null;

/** Every address of the machine, for the capture server's LAN choice. */
function flattenInterfaces(): NetIface[] {
  const out: NetIface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      out.push({ name, address: i.address, family: i.family, internal: i.internal });
    }
  }
  return out;
}

/** Loopback bind for E2E runs only (CHEF_E2E=1, unpackaged). Anything else is ignored. */
function e2eCaptureBind(): string | undefined {
  if (app.isPackaged || process.env.CHEF_E2E !== '1') return undefined;
  return process.env.CHEF_E2E_CAPTURE_BIND === '127.0.0.1' ? '127.0.0.1' : undefined;
}

let settings: SettingsStore;
let csp = '';
let openMainWindow: () => void = () => {};

async function onReady(): Promise<void> {
  log(
    `startup: app ready at ${Math.round(process.uptime() * 1000)} ms (v${app.getVersion()}, ${isDev ? 'dev' : 'packaged'})`,
  );
  settings = new SettingsStore(userData);
  let current: Settings = await settings.load();
  nativeTheme.themeSource = current.theme;

  csp = buildCsp({ devServerUrl });
  hardenSession();

  const ui = resolveUi(app.getAppPath(), app.isPackaged, process.env.CHEF_UI_DIR);
  if (ui.fallback) log(`UI build not found; serving fallback page from ${ui.root}`);
  protocol.handle(APP_SCHEME, createAppHandler({ root: ui.root, index: ui.index, csp }));
  protocol.handle(FILE_SCHEME, createFileHandler(allowlist));

  startSidecar();

  const origins = trustedOrigins(devServerUrl);
  const secrets = new SecretStore(path.join(userData, 'secrets.json'), () => safeStorage);
  const libraryDir = path.join(userData, 'library');
  const library = new ChefLibrary({
    dir: libraryDir,
    workDir: path.join(cacheDir, 'sigwork'),
    encrypt: secrets.available(),
    keys: secretKeyStore(secrets, path.join(libraryDir, 'library-key')),
  });
  await library.sweepWorkDir().catch((err) => log(`library work dir sweep failed: ${String(err)}`));
  const clipboardDir = path.join(cacheDir, 'clipboard');
  /** The first PNG item of the clipboard, as bytes (null when there is none). */
  const readClipboardPng = async (): Promise<Uint8Array | null> => {
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue;
      const blob = await item.getType('image/png');
      return new Uint8Array(await blob.arrayBuffer());
    }
    return null;
  };
  const web2pdf = createWeb2PdfHandler({
    allowlist,
    tempDir: path.join(cacheDir, 'web2pdf'),
    fonts: resolveBundledFonts([
      path.join(process.resourcesPath, 'fonts'),
      path.join(repoRootFrom(app.getAppPath()), 'core', 'chef_core', 'resources', 'fonts'),
    ]),
    render: renderToPdf,
    log,
  });
  capture = new CaptureService({
    interfaces: flattenInterfaces,
    // Test hook (E2E only, never in a packaged app): bind loopback instead of the LAN address.
    bindHost: e2eCaptureBind(),
    captureRoot: path.join(cacheDir, 'capture'),
    pageHtml: () =>
      fs.promises.readFile(path.join(app.getAppPath(), 'static', 'capture.html'), 'utf8'),
    newSessionId: () => randomBytes(8).toString('hex'),
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    },
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    emit: broadcast,
    log,
  });
  registerIpc({
    sidecar: sidecar!,
    capture,
    web2pdf,
    clipboardImage: {
      capture: () =>
        captureClipboardPng({
          source: { readPng: () => readClipboardPng() },
          dir: clipboardDir,
        }),
    },
    settings,
    secrets,
    allowlist,
    openFiles,
    library,
    trustedOrigins: origins,
    labels: () => labelsFor(settings.get().language),
    log,
    openLogs: () => void shell.openPath(logsDir),
    openDataDir: () => void shell.openPath(userData),
  });

  const menuActions = {
    about: () => void showAbout(),
  };
  const applyMenu = (s: Settings): void =>
    installMenu(labelsFor(s.language), menuActions, { platform: process.platform, isDev });
  applyMenu(current);
  settings.onChange((next) => {
    if (next.language !== current.language) applyMenu(next);
    if (next.theme !== current.theme) nativeTheme.themeSource = next.theme;
    current = next;
  });

  openMainWindow = () => {
    const win = createMainWindow({
      preloadPath: path.join(__dirname, '../preload/index.js'),
      statePath: path.join(userData, 'window-state.json'),
      appVersion: app.getVersion(),
      devServerUrl,
      title: APP_TITLE,
      log,
      // E2E runs keep the window off screen (dev with CHEF_E2E, packaged with CHEF_E2E_OFFSCREEN)
      // unless a spec asks for a visible one (CHEF_E2E_SHOW).
      offscreen:
        process.env.CHEF_E2E_SHOW !== '1' &&
        ((!app.isPackaged && process.env.CHEF_E2E === '1') ||
          process.env.CHEF_E2E_OFFSCREEN === '1'),
    });
    mainWindow = win;
    const deliverFiles = (paths: string[]) => {
      broadcast({ type: 'open-files', paths });
      focusMainWindow();
    };
    openFiles.prepare(deliverFiles);
    win.webContents.on('did-finish-load', () => {
      log(`startup: renderer loaded at ${Math.round(process.uptime() * 1000)} ms`);
      win.webContents.send(IpcChannels.event, {
        type: 'core-status',
        status: coreStatus,
      } satisfies ChefEvent);
      openFiles.attach(deliverFiles);
    });
    win.on('closed', () => {
      if (mainWindow === win) {
        mainWindow = null;
        openFiles.detach();
      }
    });
  };
  openMainWindow();

  app.on('activate', () => {
    if (!mainWindow) openMainWindow();
  });
}

function startSidecar(): void {
  const core = resolveCoreCommand({
    dataDir: userData,
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    repoRoot: repoRootFrom(app.getAppPath()),
    override: process.env.CHEF_CORE_CMD,
  });
  sidecar = new SidecarManager({
    core,
    log: new RotatingLog(path.join(logsDir, 'core.log')),
  });
  sidecar.on('status', (status) => {
    coreStatus = status;
    log(`core status: ${status}`);
    broadcast({ type: 'core-status', status });
  });
  sidecar.on('notification', (method, params) => {
    broadcast({
      type: 'rpc',
      name: method as RpcNotification,
      payload: params as RpcNotifications[RpcNotification],
    });
  });
  sidecar.start();
}

function hardenSession(): void {
  const ses = session.defaultSession;
  const allowedPermissions = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(allowedPermissions.has(permission)),
  );
  ses.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission));
  if (devServerUrl) {
    // The dev server's HTML has no CSP header; add ours so dev matches production behaviour.
    const filter = { urls: [`${new URL(devServerUrl).origin}/*`] };
    ses.webRequest.onHeadersReceived(filter, (details, callback) => {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame') headers['Content-Security-Policy'] = [csp];
      callback({ responseHeaders: headers });
    });
  }
}

async function showAbout(): Promise<void> {
  const l = labelsFor(settings.get().language);
  const v = process.versions;
  const opts = {
    type: 'info' as const,
    title: l.about,
    message: APP_TITLE,
    detail: l.aboutDetail(app.getVersion(), v.electron ?? '', v.chrome ?? '', v.node ?? ''),
  };
  if (mainWindow) await dialog.showMessageBox(mainWindow, opts);
  else await dialog.showMessageBox(opts);
}

// --- Lifecycle ---
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let shutdownDone = false;
app.on('before-quit', (event) => {
  // A phone capture server must not outlive the app (its sockets would hold the process).
  void capture?.stop();
  if (shutdownDone || !sidecar) return;
  event.preventDefault();
  const s = sidecar;
  sidecar = null;
  log('quitting: stopping core');
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 8000));
  void Promise.race([Promise.all([s.stop(), settings?.flush()]), deadline]).finally(() => {
    shutdownDone = true;
    log('quitting: done');
    app.quit();
  });
});
