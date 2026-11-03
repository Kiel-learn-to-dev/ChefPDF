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

/**
 * A signature look saved in settings (I10). `template` is a SignatureTemplate wire object without
 * the image / logo paths: those are kept as library references and resolved when used.
 */
export interface SignTemplateEntry {
  id: string;
  name: string;
  template: Record<string, unknown>;
  /** SHA-256 fingerprint of the certificate this template is bound to (I10). */
  certFingerprint?: string;
  /** Library item ids for the image and logo slots (I18). */
  libraryRefs?: { image?: string; logo?: string };
}

export type LibraryKind = 'signature' | 'stamp' | 'initials' | 'logo';

export interface LibraryItem {
  id: string;
  name: string;
  kind: LibraryKind;
  /** ISO 8601 time the item was added. */
  createdAt: string;
}

export interface LibraryStatus {
  /** False when the OS offers no secure storage: items are then kept as plain PNG files. */
  encrypted: boolean;
}

/** Exactly one of `path` (PNG file) or `bytes` (PNG data) is given. */
export interface LibraryAddInput {
  kind: LibraryKind;
  name: string;
  path?: string;
  bytes?: Uint8Array;
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
  /** Signature templates (I10). Missing in older files: defaults to []. At most 50. */
  signTemplates: SignTemplateEntry[];
  /** Timestamp server URLs (I28), tried in order. Max 5, http(s) only. Missing in older files: []. */
  tsaUrls: string[];
  /** User watermark presets (F1). Missing in older files: []. At most 50. */
  overlayPresets: OverlayUserPreset[];
  /** User presets of "Nén PDF" (M1). Missing in older files: []. At most 50. */
  compressPresets: CompressUserPreset[];
  /** Name put in the {user} stamp variable (F2). Missing in older files: ''. At most 80 characters. */
  userName: string;
}

/**
 * A named watermark look (F1) saved by the user. `params` is a plain object with the look only
 * (font size, bold, colour, opacity, rotation): never a file path or a page list.
 */
export interface OverlayUserPreset {
  name: string;
  kind: 'watermark';
  params: Record<string, unknown>;
}

/**
 * A named set of compression options (M1) saved by the user. `params` holds only the option
 * values of the compression form: never a file path or a page list.
 */
export interface CompressUserPreset {
  name: string;
  params: Record<string, unknown>;
}

/** Source kinds of "Trang web / Markdown → PDF" (T5.06). `url` is remote; the others are local. */
export type Web2PdfKind = 'url' | 'html' | 'markdown' | 'file';

export interface Web2PdfOptions {
  pageSize: 'A4' | 'Letter';
  landscape: boolean;
  /** Margins in millimetres, 0 to 50 each. */
  marginsMm: { top: number; right: number; bottom: number; left: number };
  printBackground: boolean;
  /** Rendering scale, 0.1 to 2. */
  scale: number;
  /** Page number footer and title header. */
  headerFooter: boolean;
}

export interface Web2PdfRequest {
  kind: Web2PdfKind;
  /** http(s) URL for `url`; absolute path of a file the user picked for the other kinds. */
  source: string;
  /** Absolute path of the .pdf file to write. */
  outputPath: string;
  /** Must be true for `url`: the user has confirmed loading the remote page. */
  confirmed?: boolean;
  options?: Partial<Web2PdfOptions>;
}

export interface Web2PdfResult {
  outputPath: string;
  sizeBytes: number;
}

export type ChefEvent =
  | { type: 'rpc'; name: RpcNotification; payload: RpcNotifications[RpcNotification] }
  | { type: 'open-files'; paths: string[] }
  | { type: 'core-status'; status: 'starting' | 'ready' | 'crashed' | 'restarting' }
  | { type: 'capture-image'; index: number; path: string }
  | { type: 'capture-status'; state: CaptureState; count: number; expiresAt: number };

/** Phone capture (L5). `idle` = no session running. */
export type CaptureState = 'active' | 'done' | 'stopped' | 'expired';

export interface CaptureStartInput {
  purpose: 'book' | 'signature';
  /** 1 to 500, default 200. */
  maxPages?: number;
  /** Name of the LAN interface to use (default: the first private IPv4 one). */
  interfaceName?: string;
}

export interface LanInterface {
  name: string;
  address: string;
}

export interface CaptureStartResult {
  /** Identifies this session so a late dialog cleanup cannot stop a newer session. */
  sessionId: string;
  /** http://<LAN address>:<port>/c/<token>. The token only travels inside this URL. */
  url: string;
  /** QR code of `url` as an SVG string. */
  qrSvg: string;
  expiresAt: number;
  /** Private LAN addresses the machine offers. */
  interfaces: LanInterface[];
}

export interface CaptureStatus {
  state: CaptureState | 'idle';
  count: number;
  expiresAt?: number;
}

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
    /** PDF files directly inside a folder the user picked with openDialog({ directory: true }) (batch signing). */
    listPdfs(absDir: string): Promise<string[]>;
    /** Reads a small .json file the user picked with openDialog (512 KB at most). */
    readText(absPath: string): Promise<string>;
    /** Writes a small .json file at a path chosen with saveDialog (512 KB at most). */
    writeText(absPath: string, text: string): Promise<void>;
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
  /**
   * Signature and stamp image library (I19-I23). Items are PNG files in userData/library, encrypted
   * with AES-256-GCM when the OS offers secure storage. Decrypted copies only exist as short-lived
   * files in the work directory (see materialize / release).
   */
  library: {
    status(): Promise<LibraryStatus>;
    list(): Promise<LibraryItem[]>;
    add(input: LibraryAddInput): Promise<LibraryItem>;
    /** PNG bytes of an item. */
    get(id: string): Promise<Uint8Array>;
    rename(id: string, name: string): Promise<LibraryItem>;
    remove(id: string): Promise<void>;
    /** Decrypts an item to a PNG file in the work directory; returns its absolute path. */
    materialize(id: string): Promise<string>;
    /** Deletes a file inside the work directory (only those files are accepted). */
    release(absPath: string): Promise<void>;
    /** Absolute path of the work directory for files the core writes (inside the app cache). */
    workDir(): Promise<string>;
  };
  /** Web, Markdown and HTML to PDF (T5.06). Runs in the main process; output is a file. */
  convert: {
    toPdf(request: Web2PdfRequest): Promise<Web2PdfResult>;
  };
  /**
   * Phone capture (L5): a temporary LAN server runs only while a session is active. Photos arrive as
   * `capture-image` events (paths in the cache, readable through chef-file).
   */
  capture: {
    start(input: CaptureStartInput): Promise<CaptureStartResult>;
    stop(sessionId?: string): Promise<void>;
    status(): Promise<CaptureStatus>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
    writeImagePng(dataUrl: string): Promise<void>;
    readImagePng(): Promise<string | null>;
    /**
     * PNG on the clipboard (M4), saved in the work directory: resolves to its absolute path (the
     * bytes never reach the renderer), or null when the clipboard holds no PNG image.
     */
    readImage(): Promise<string | null>;
  };
}

declare global {
  interface Window {
    chef: ChefBridge;
  }
}
