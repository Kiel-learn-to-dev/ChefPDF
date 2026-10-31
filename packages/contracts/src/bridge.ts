/**
 * API exposed by the preload script on `window.chef` (contextBridge).
 * Source of truth: docs/CONTRACTS.md. Keep both in sync.
 */
import type { RpcMethod, RpcNotification, RpcNotifications, RpcParams, RpcResult } from './rpc';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

export type ThemeSetting = 'system' | 'light' | 'dark';
export type LanguageSetting = 'vi' | 'en';

/** A user-saved preset for "Chuyển thành bản scan" (K8). `params` is a scan.rasterize wire object without `pages`. */
export interface ScanUserPreset {
  name: string;
  params: Record<string, unknown>;
}

/** A .pfx / .p12 certificate file the user has used before (K-sign). Password is never here. */
export interface KnownPfxFile {
  path: string;
  label: string;
  /** True when the password is kept encrypted with safeStorage (see `chef.secrets`). */
  remembered?: boolean;
}

export interface Settings {
  version: 1;
  language: LanguageSetting;
  theme: ThemeSetting;
  defaultSaveDir: string | null;
  recentFiles: RecentFile[];
  /** Free-form per-feature preferences, keyed by feature code (e.g. "K"). */
  prefs: Record<string, unknown>;
  /** User presets for scan conversion (K8). Missing in older files: defaults to []. */
  scanPresets: ScanUserPreset[];
  /** Certificate files used before (T3.04). Missing in older files: defaults to []. */
  knownPfxFiles: KnownPfxFile[];
  /** Driver file of the last token session (T3.02). Missing in older files: null. */
  lastDriverPath: string | null;
}

export type ChefEvent =
  | { type: 'rpc'; name: RpcNotification; payload: RpcNotifications[RpcNotification] }
  | { type: 'open-files'; paths: string[] }
  | { type: 'core-status'; status: 'starting' | 'ready' | 'crashed' | 'restarting' };

export interface ChefBridge {
  rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  /** Subscribe to events. Returns an unsubscribe function. */
  onEvent(listener: (event: ChefEvent) => void): () => void;
  files: {
    /** `directory: true` picks folders instead of files (filters are ignored). */
    openDialog(options?: {
      multiple?: boolean;
      directory?: boolean;
      filters?: FileFilter[];
    }): Promise<string[]>;
    saveDialog(options?: { defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
    /** URL the renderer can fetch/pass to pdf.js for a local session file. */
    toUrl(absPath: string): string;
    showInFolder(absPath: string): Promise<void>;
    /**
     * Absolute path of a File from a drag-and-drop event (Electron webUtils.getPathForFile).
     * Returns '' when the File has no backing path. The path is also granted to chef-file.
     */
    pathForFile(file: File): string;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
    addRecent(path: string): Promise<Settings>;
  };
  app: {
    version: string;
    platform: 'win32' | 'darwin' | 'linux';
    /** Paths passed on the command line / by the OS at launch. */
    initialFiles(): Promise<string[]>;
  };
  /**
   * Encrypted secrets with the OS keychain (Electron safeStorage). Only PFX passwords are stored
   * this way; PINs are never stored. `key` is the absolute path of the certificate file; the main
   * process hashes it before using it as a file key. `get` returns the plain secret to the renderer
   * only when the user asks for it (the renderer is the app's own UI, not a remote page).
   */
  secrets: {
    /** False when the OS offers no encryption: the UI must not offer "remember". */
    available(): Promise<boolean>;
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
    writeImagePng(dataUrl: string): Promise<void>;
    readImagePng(): Promise<string | null>;
  };
}

declare global {
  interface Window {
    chef: ChefBridge;
  }
}
