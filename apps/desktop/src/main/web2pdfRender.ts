/**
 * Electron side of T5.06: prints a page with a hidden (show: false), sandboxed BrowserWindow.
 * Not unit-tested (needs Electron); the e2e spec tests/e2e/specs/web2pdf.spec.ts covers it.
 *
 * Hardening: no node integration, context isolation, sandbox, no permissions, no popups, in-memory
 * session, request filter (file: only inside the job's folders, http(s) only for remote pages),
 * navigation limited to the loaded document, JavaScript off for local documents.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import { allowRequest, type RenderJob } from './web2pdf';

/** Print one job. The window is always destroyed; the abort signal destroys it early. */
export async function renderToPdf(job: RenderJob): Promise<Buffer> {
  // A partition without the "persist:" prefix is in memory only: nothing is kept after the job.
  const ses = session.fromPartition(`web2pdf-${randomUUID()}`);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const realpath = (p: string): string | null => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  };
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowRequest(details.url, job, realpath) });
  });

  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      javascript: job.javascript,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      spellcheck: false,
      enableWebSQL: false,
    },
  });

  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    // Only the document itself, or http(s) for a remote page; everything else is refused.
    const remote = job.allowRemote && /^https?:/i.test(url);
    if (!remote) event.preventDefault();
  });

  const loaded = new Promise<void>((resolve, reject) => {
    contents.once('did-finish-load', () => resolve());
    contents.once('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame) reject(new Error(`page did not load: ${description} (${code})`));
    });
  });
  loaded.catch(() => undefined); // reported through the awaited promise below

  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy();
  };
  job.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (job.url) void win.loadURL(job.url).catch(() => undefined);
    else if (job.file) void win.loadFile(job.file).catch(() => undefined);
    else throw new Error('no page to print');
    await loaded;
    if (job.signal.aborted) throw new Error('aborted');
    return await contents.printToPDF(job.printOptions);
  } finally {
    job.signal.removeEventListener('abort', onAbort);
    if (!win.isDestroyed()) win.destroy();
  }
}
