/**
 * Preload (sandboxed): exposes `window.chef` exactly as `ChefBridge` in
 * packages/contracts/src/bridge.ts. Only `electron`'s renderer modules are available here.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
    listPdfs: (absDir) => ipcRenderer.invoke(IpcChannels.filesListPdfs, absDir),
    readText: (absPath) => ipcRenderer.invoke(IpcChannels.filesReadText, absPath),
    writeText: (absPath, text) => ipcRenderer.invoke(IpcChannels.filesWriteText, absPath, text),
    pathForFile: (file) => {
      const p = webUtils.getPathForFile(file);
      // Grant the dropped file to the chef-file protocol (fire-and-forget; main validates it).
      if (p) ipcRenderer.send(IpcChannels.filesGrant, p);
      return p;
    },
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

  secrets: {
    available: () => ipcRenderer.invoke(IpcChannels.secretsAvailable),
    set: (key, value) => ipcRenderer.invoke(IpcChannels.secretsSet, key, value),
    get: (key) => ipcRenderer.invoke(IpcChannels.secretsGet, key),
    delete: (key) => ipcRenderer.invoke(IpcChannels.secretsDelete, key),
  },

  library: {
    status: () => ipcRenderer.invoke(IpcChannels.libraryStatus),
    list: () => ipcRenderer.invoke(IpcChannels.libraryList),
    add: (input) => ipcRenderer.invoke(IpcChannels.libraryAdd, input),
    get: (id) => ipcRenderer.invoke(IpcChannels.libraryGet, id),
    rename: (id, name) => ipcRenderer.invoke(IpcChannels.libraryRename, id, name),
    remove: (id) => ipcRenderer.invoke(IpcChannels.libraryRemove, id),
    materialize: (id) => ipcRenderer.invoke(IpcChannels.libraryMaterialize, id),
    release: (absPath) => ipcRenderer.invoke(IpcChannels.libraryRelease, absPath),
    workDir: () => ipcRenderer.invoke(IpcChannels.libraryWorkDir),
  },

  clipboard: {
    writeText: (text) => ipcRenderer.invoke(IpcChannels.clipboardWriteText, text),
    writeImagePng: (dataUrl) => ipcRenderer.invoke(IpcChannels.clipboardWriteImagePng, dataUrl),
    readImagePng: () => ipcRenderer.invoke(IpcChannels.clipboardReadImagePng),
  },
};

contextBridge.exposeInMainWorld('chef', bridge);
