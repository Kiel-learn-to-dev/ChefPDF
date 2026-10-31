/**
 * Preload (sandboxed): exposes `window.chef` exactly as `ChefBridge` in
 * packages/contracts/src/bridge.ts. Only `electron`'s renderer modules are available here.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ChefBridge, ChefEvent } from '@chef/contracts';
import { APP_VERSION_ARG, IpcChannels, fileUrl, type RpcEnvelope } from '../shared/ipc';

type Listener = (event: ChefEvent) => void;

const listeners = new Set<Listener>();
// Events that arrive before the UI subscribes are kept and replayed to the first listener,
// so files opened from the OS / the initial core status are never lost.
let backlog: ChefEvent[] = [];
let lastStatus: ChefEvent | null = null;
let hadListener = false;

ipcRenderer.on(IpcChannels.event, (_e, event: ChefEvent) => {
  if (event.type === 'core-status') lastStatus = event;
  if (listeners.size === 0) {
    if (!hadListener && event.type === 'open-files') backlog.push(event);
    return;
  }
  for (const l of [...listeners]) {
    try {
      l(event);
    } catch (err) {
      console.error('chef.onEvent listener failed', err);
    }
  }
});

const appVersion =
  process.argv.find((a) => a.startsWith(APP_VERSION_ARG))?.slice(APP_VERSION_ARG.length) ?? '0.0.0';
const platform = process.platform as 'win32' | 'darwin' | 'linux';

const bridge: ChefBridge = {
  async rpc(method, params) {
    const res = (await ipcRenderer.invoke(IpcChannels.rpc, method, params)) as RpcEnvelope;
    if (res.ok) return res.result as never;
    // Reject with a plain RpcError-shaped object: contextBridge drops custom Error properties.
    throw { name: 'RpcError', ...res.error };
  },

  onEvent(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    if (!hadListener) {
      hadListener = true;
      const replay = [...(lastStatus ? [lastStatus] : []), ...backlog];
      backlog = [];
      queueMicrotask(() => {
        for (const e of replay) if (listeners.has(listener)) listener(e);
      });
    } else if (lastStatus) {
      const status = lastStatus;
      queueMicrotask(() => listeners.has(listener) && listener(status));
    }
    return () => {
      listeners.delete(listener);
    };
  },

  files: {
    openDialog: (options) => ipcRenderer.invoke(IpcChannels.filesOpenDialog, options),
    saveDialog: (options) => ipcRenderer.invoke(IpcChannels.filesSaveDialog, options),
    toUrl: (absPath) => {
      if (typeof absPath !== 'string') throw new TypeError('absPath must be a string');
      return fileUrl(absPath);
    },
    showInFolder: (absPath) => ipcRenderer.invoke(IpcChannels.filesShowInFolder, absPath),
  },

  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
    set: (patch) => ipcRenderer.invoke(IpcChannels.settingsSet, patch),
    addRecent: (path) => ipcRenderer.invoke(IpcChannels.settingsAddRecent, path),
  },

  app: {
    version: appVersion,
    platform,
    initialFiles: () => ipcRenderer.invoke(IpcChannels.appInitialFiles),
  },

  clipboard: {
    writeText: (text) => ipcRenderer.invoke(IpcChannels.clipboardWriteText, text),
    writeImagePng: (dataUrl) => ipcRenderer.invoke(IpcChannels.clipboardWriteImagePng, dataUrl),
    readImagePng: () => ipcRenderer.invoke(IpcChannels.clipboardReadImagePng),
  },
};

contextBridge.exposeInMainWorld('chef', bridge);
