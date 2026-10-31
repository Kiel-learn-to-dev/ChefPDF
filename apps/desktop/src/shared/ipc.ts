/**
 * IPC channel names shared by main and preload. Internal to apps/desktop:
 * the renderer only sees `window.chef` (packages/contracts/src/bridge.ts).
 */
export const IpcChannels = {
  rpc: 'chef:rpc',
  event: 'chef:event',
  filesOpenDialog: 'chef:files.openDialog',
  filesSaveDialog: 'chef:files.saveDialog',
  filesShowInFolder: 'chef:files.showInFolder',
  filesGrant: 'chef:files.grant',
  settingsGet: 'chef:settings.get',
  settingsSet: 'chef:settings.set',
  settingsAddRecent: 'chef:settings.addRecent',
  appInitialFiles: 'chef:app.initialFiles',
  clipboardWriteText: 'chef:clipboard.writeText',
  clipboardWriteImagePng: 'chef:clipboard.writeImagePng',
  clipboardReadImagePng: 'chef:clipboard.readImagePng',
} as const;

/** Envelope used for `chef:rpc` so structured RPC errors survive IPC. */
export type RpcEnvelope =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: number; message: string; data?: { kind: string; detail?: unknown } };
    };

/** Command-line switch used to hand the app version to the sandboxed preload. */
export const APP_VERSION_ARG = '--chef-app-version=';

/** URL scheme / host used by `files.toUrl` (docs/CONTRACTS.md section 5). */
export const FILE_SCHEME = 'chef-file';
export const FILE_HOST = 'f';

/** Custom scheme serving the built UI (and the fallback page). */
export const APP_SCHEME = 'chef-app';
export const APP_HOST = 'ui';

export function fileUrl(absPath: string): string {
  return `${FILE_SCHEME}://${FILE_HOST}/${encodeURIComponent(absPath)}`;
}
