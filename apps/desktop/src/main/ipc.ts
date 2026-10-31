/**
 * ipcMain handlers backing `window.chef` (packages/contracts/src/bridge.ts).
 * Every handler checks the sender origin and validates its input.
 */
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  ClipboardItem,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { statSync } from 'node:fs';
import { IpcChannels, type RpcEnvelope } from '../shared/ipc';
import type { PathAllowlist } from './allowlist';
import type { Labels } from './labels';
import type { OpenFilesController } from './openFiles';
import { toRpcError } from './rpc';
import type { SecretStore } from './secrets';
import type { SettingsStore } from './settings';
import type { SidecarManager } from './sidecar';
import {
  IpcValidationError,
  pngBytesFromDataUrl,
  resolveDefaultSavePath,
  validateAbsPath,
  validateOpenDialogOptions,
  validatePngDataUrl,
  validateRpcCall,
  validateSaveDialogOptions,
  validateSecretKey,
  validateSecretValue,
  validateText,
} from './validate';
import { originOf } from './window';

export interface IpcDeps {
  sidecar: SidecarManager;
  settings: SettingsStore;
  secrets: SecretStore;
  allowlist: PathAllowlist;
  openFiles: OpenFilesController;
  trustedOrigins: Set<string>;
  labels(): Labels;
  log(message: string): void;
}

export function defaultOpenFilters(l: Labels): OpenDialogOptions['filters'] {
  return [
    { name: l.pdfFiles, extensions: ['pdf'] },
    { name: l.allFiles, extensions: ['*'] },
  ];
}

export function registerIpc(d: IpcDeps): void {
  const assertTrusted = (event: IpcMainInvokeEvent): void => {
    const url = event.senderFrame?.url ?? '';
    const origin = originOf(url);
    if (!origin || !d.trustedOrigins.has(origin)) {
      d.log(`rejected IPC from untrusted origin: ${url.slice(0, 200)}`);
      throw new IpcValidationError('Untrusted sender');
    }
  };

  const handle = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertTrusted(event);
      return fn(event, ...args);
    });
  };

  // RPC: errors travel inside the envelope so `code` / `data.kind` survive IPC.
  ipcMain.handle(
    IpcChannels.rpc,
    async (event, method: unknown, params: unknown): Promise<RpcEnvelope> => {
      try {
        assertTrusted(event);
        const call = validateRpcCall(method, params);
        const result = await d.sidecar.request(call.method, call.params);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: toRpcError(err) };
      }
    },
  );

  handle(IpcChannels.filesOpenDialog, async (event, options) => {
    const o = validateOpenDialogOptions(options);
    const dialogOptions: OpenDialogOptions = o.directory
      ? {
          properties: o.multiple
            ? ['openDirectory', 'createDirectory', 'multiSelections']
            : ['openDirectory', 'createDirectory'],
        }
      : {
          properties: o.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          filters: o.filters ?? defaultOpenFilters(d.labels()),
        };
    const parent = BrowserWindow.fromWebContents(event.sender);
    const res = parent
      ? await dialog.showOpenDialog(parent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (res.canceled) return [];
    if (!o.directory) for (const p of res.filePaths) d.allowlist.addFile(p);
    return res.filePaths;
  });

  handle(IpcChannels.filesSaveDialog, async (event, options) => {
    const o = validateSaveDialogOptions(options);
    const dialogOptions: SaveDialogOptions = {
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const defaultPath = resolveDefaultSavePath(o.defaultPath, d.settings.get().defaultSaveDir);
    if (defaultPath) dialogOptions.defaultPath = defaultPath;
    if (o.filters) dialogOptions.filters = o.filters;
    const parent = BrowserWindow.fromWebContents(event.sender);
    const res = parent
      ? await dialog.showSaveDialog(parent, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    return res.canceled || !res.filePath ? null : res.filePath;
  });

  handle(IpcChannels.filesShowInFolder, (_event, p) => {
    shell.showItemInFolder(validateAbsPath(p));
  });

  // Dropped files (preload `files.pathForFile`): grant regular files to chef-file.
  ipcMain.on(IpcChannels.filesGrant, (event, p: unknown) => {
    try {
      const url = event.senderFrame?.url ?? '';
      const origin = originOf(url);
      if (!origin || !d.trustedOrigins.has(origin)) return;
      const abs = validateAbsPath(p);
      if (statSync(abs, { throwIfNoEntry: false })?.isFile()) d.allowlist.addFile(abs);
    } catch (err) {
      d.log(`files.grant rejected: ${String(err)}`);
    }
  });

  handle(IpcChannels.settingsGet, () => d.settings.get());
  handle(IpcChannels.settingsSet, (_event, patch) => d.settings.set(patch));
  handle(IpcChannels.settingsAddRecent, (_event, p) => d.settings.addRecent(validateAbsPath(p)));

  // Secrets (PFX passwords). `get` returns the plain value to the renderer: only the app's own
  // UI calls it, on an explicit user action (for example "open this remembered certificate").
  handle(IpcChannels.secretsAvailable, () => d.secrets.available());
  handle(IpcChannels.secretsSet, async (_event, key, value) => {
    await d.secrets.set(validateSecretKey(key), validateSecretValue(value));
  });
  handle(IpcChannels.secretsGet, (_event, key) => d.secrets.get(validateSecretKey(key)));
  handle(IpcChannels.secretsDelete, (_event, key) => d.secrets.delete(validateSecretKey(key)));

  handle(IpcChannels.appInitialFiles, () => d.openFiles.initialFiles);

  handle(IpcChannels.clipboardWriteText, async (_event, text) => {
    await clipboard.writeText(validateText(text));
  });
  handle(IpcChannels.clipboardWriteImagePng, async (_event, dataUrl) => {
    const bytes = pngBytesFromDataUrl(validatePngDataUrl(dataUrl));
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) }),
    ]);
  });
  handle(IpcChannels.clipboardReadImagePng, async () => {
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue;
      const blob = await item.getType('image/png');
      const buf = Buffer.from(await blob.arrayBuffer());
      return `data:image/png;base64,${buf.toString('base64')}`;
    }
    return null;
  });
}
