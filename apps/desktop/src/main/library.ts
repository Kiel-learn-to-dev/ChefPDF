/**
 * Signature and stamp image library (I19-I23, docs/BLUEPRINT.md section 7).
 *
 * - Items are PNG files in `<userData>/library/`, named by a random id. When the OS offers secure
 *   storage they are sealed with AES-256-GCM (file: magic + iv + tag + ciphertext); the 256-bit key
 *   is kept through the key store (SecretStore / safeStorage). Without secure storage the PNG is
 *   written as is and the UI shows a warning.
 * - `index.json` keeps names, kinds, ids and creation times only.
 * - Decrypted copies exist only as short-lived files in the work directory (`materialize`).
 * - Pure Node: crypto, file system and key store are injected, so the tests use a temp directory.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LibraryItem, LibraryKind, LibraryStatus } from '@chef/contracts';
import { atomicWriteFile, isPlainObject, readJsonFile } from './fsutil';
import type { SecretStore } from './secrets';

export const MAX_LIBRARY_ITEMS = 200;
export const MAX_LIBRARY_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_LIBRARY_NAME = 80;
export const LIBRARY_KINDS: readonly LibraryKind[] = ['signature', 'stamp', 'initials', 'logo'];
const ID_RE = /^[a-f0-9]{32}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGIC = Buffer.from('CHLIB1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type LibraryErrorCode =
  | 'LIBRARY_INVALID'
  | 'LIBRARY_NOT_FOUND'
  | 'LIBRARY_FULL'
  | 'LIBRARY_KEY_MISSING'
  | 'LIBRARY_TAMPERED';

export class LibraryError extends Error {
  /** The message starts with the code, so the renderer can map it (see lib/errors.ts). */
  constructor(
    readonly code: LibraryErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LibraryError';
  }
}

/** Where the 256-bit key lives. Production: SecretStore (safeStorage). */
export interface LibraryKeyStore {
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<void>;
}

export interface LibraryDeps {
  /** `<userData>/library` */
  dir: string;
  /** `<userData>/cache/sigwork`: decrypted copies and core outputs. */
  workDir: string;
  /** False when the OS has no secure storage: new items are stored as plain PNG. */
  encrypt: boolean;
  keys: LibraryKeyStore;
  now?: () => Date;
}

interface IndexItem extends LibraryItem {
  /** True when the file is sealed (`<id>.enc`), false for a plain `<id>.png`. */
  encrypted: boolean;
}

interface IndexFile {
  version: 1;
  items: IndexItem[];
}

/** Keeps well-formed index entries from untrusted disk data; invalid ones are dropped. */
export function sanitizeLibraryIndex(raw: unknown): IndexItem[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.items)) return [];
  const out: IndexItem[] = [];
  const seen = new Set<string>();
  for (const v of raw.items) {
    if (!isPlainObject(v)) continue;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (
      typeof v.id !== 'string' ||
      !ID_RE.test(v.id) ||
      seen.has(v.id) ||
      name.length === 0 ||
      name.length > MAX_LIBRARY_NAME ||
      !LIBRARY_KINDS.includes(v.kind as LibraryKind) ||
      typeof v.createdAt !== 'string' ||
      Number.isNaN(Date.parse(v.createdAt)) ||
      typeof v.encrypted !== 'boolean'
    ) {
      continue;
    }
    seen.add(v.id);
    out.push({
      id: v.id,
      name,
      kind: v.kind as LibraryKind,
      createdAt: v.createdAt,
      encrypted: v.encrypted,
    });
    if (out.length >= MAX_LIBRARY_ITEMS) break;
  }
  return out;
}

/** Name trimmed and bounded; throws LibraryError on an empty or too long name. */
export function normalizeLibraryName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0 || trimmed.length > MAX_LIBRARY_NAME) {
    throw new LibraryError('LIBRARY_INVALID', `name must be 1 to ${MAX_LIBRARY_NAME} characters`);
  }
  return trimmed;
}

export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)
  );
}

/** Seals `plain` with AES-256-GCM. Layout: magic (6) | iv (12) | tag (16) | ciphertext. */
export function sealBytes(key: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Opens a sealed file. Any change to the bytes (including the tag) throws LIBRARY_TAMPERED. */
export function openBytes(key: Buffer, sealed: Buffer): Buffer {
  const headerLen = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (sealed.length < headerLen || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new LibraryError('LIBRARY_TAMPERED', 'library file is not a sealed item');
  }
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = sealed.subarray(MAGIC.length + IV_BYTES, headerLen);
  const body = sealed.subarray(headerLen);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new LibraryError('LIBRARY_TAMPERED', 'library item failed authentication');
  }
}

/** Key store backed by SecretStore (safeStorage). The key is kept under a fixed path-like key. */
export function secretKeyStore(secrets: SecretStore, keyId: string): LibraryKeyStore {
  return {
    async load() {
      const value = await secrets.get(keyId);
      if (value === null) return null;
      const key = Buffer.from(value, 'base64');
      return key.length === KEY_BYTES ? key : null;
    },
    async save(key) {
      await secrets.set(keyId, key.toString('base64'));
    },
  };
}

export class ChefLibrary {
  private items: IndexItem[] = [];
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly deps: LibraryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Work directory for decrypted copies and core outputs. */
  get workDirPath(): string {
    return this.deps.workDir;
  }

  private get indexFile(): string {
    return path.join(this.deps.dir, 'index.json');
  }

  /** Serialises every operation so index writes never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const res = await readJsonFile(this.indexFile);
    if (res.ok) {
      this.items = sanitizeLibraryIndex(res.value);
    } else {
      if (!res.missing) {
        await fs
          .rename(this.indexFile, `${this.indexFile}.corrupt-${this.now().getTime()}`)
          .catch(() => undefined);
      }
      this.items = [];
    }
    this.loaded = true;
  }

  private async saveIndex(): Promise<void> {
    const body: IndexFile = { version: 1, items: this.items };
    await atomicWriteFile(this.indexFile, JSON.stringify(body, null, 2) + '\n');
  }

  private filePath(item: IndexItem): string {
    return path.join(this.deps.dir, `${item.id}.${item.encrypted ? 'enc' : 'png'}`);
  }

  private toPublic(item: IndexItem): LibraryItem {
    return { id: item.id, name: item.name, kind: item.kind, createdAt: item.createdAt };
  }

  private find(id: string): IndexItem {
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new LibraryError('LIBRARY_NOT_FOUND', 'library item not found');
    return item;
  }

  async status(): Promise<LibraryStatus> {
    return { encrypted: this.deps.encrypt };
  }

  list(): Promise<LibraryItem[]> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      return this.items.map((i) => this.toPublic(i));
    });
  }

  add(input: { kind: LibraryKind; name: string; bytes: Uint8Array }): Promise<LibraryItem> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      if (!LIBRARY_KINDS.includes(input.kind)) {
        throw new LibraryError('LIBRARY_INVALID', 'unknown library kind');
      }
      const name = normalizeLibraryName(input.name);
      if (!isPng(input.bytes) || input.bytes.length > MAX_LIBRARY_IMAGE_BYTES) {
        throw new LibraryError('LIBRARY_INVALID', 'library items must be PNG files up to 8 MB');
      }
      if (this.items.length >= MAX_LIBRARY_ITEMS) {
        throw new LibraryError(
          'LIBRARY_FULL',
          `the library holds at most ${MAX_LIBRARY_ITEMS} items`,
        );
      }
      let key: Buffer | null = null;
      if (this.deps.encrypt) {
        key = await this.keyForWrite();
      }
      const item: IndexItem = {
        id: randomBytes(16).toString('hex'),
        name,
        kind: input.kind,
        createdAt: this.now().toISOString(),
        encrypted: this.deps.encrypt,
      };
      await fs.mkdir(this.deps.dir, { recursive: true });
      const data = key ? sealBytes(key, input.bytes) : Buffer.from(input.bytes);
      await atomicWriteFile(this.filePath(item), data);
      this.items = [...this.items, item];
      try {
        await this.saveIndex();
      } catch (err) {
        this.items = this.items.filter((i) => i.id !== item.id);
        await fs.rm(this.filePath(item), { force: true });
        throw err;
      }
      return this.toPublic(item);
    });
  }

  /** Key for new sealed items: created once, then reused. Refuses to start a new key when items exist. */
  private async keyForWrite(): Promise<Buffer> {
    const existing = await this.deps.keys.load();
    if (existing) return existing;
    if (this.items.some((i) => i.encrypted)) {
      throw new LibraryError('LIBRARY_KEY_MISSING', 'the library key is missing');
    }
    const key = randomBytes(KEY_BYTES);
    await this.deps.keys.save(key);
    return key;
  }

  get(id: string): Promise<Buffer> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const item = this.find(id);
      const raw = await fs.readFile(this.filePath(item));
      if (!item.encrypted) return raw;
      const key = await this.deps.keys.load();
      if (!key) throw new LibraryError('LIBRARY_KEY_MISSING', 'the library key is missing');
      return openBytes(key, raw);
    });
  }

  rename(id: string, name: string): Promise<LibraryItem> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const item = this.find(id);
      const next = normalizeLibraryName(name);
      const updated = { ...item, name: next };
      this.items = this.items.map((i) => (i.id === id ? updated : i));
      await this.saveIndex();
      return this.toPublic(updated);
    });
  }

  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const item = this.find(id);
      this.items = this.items.filter((i) => i.id !== id);
      await this.saveIndex();
      await fs.rm(this.filePath(item), { force: true });
    });
  }

  /** Decrypts an item into a PNG in the work directory. The caller releases it. */
  materialize(id: string): Promise<string> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const item = this.find(id);
      const raw = await fs.readFile(this.filePath(item));
      let png: Buffer = raw;
      if (item.encrypted) {
        const key = await this.deps.keys.load();
        if (!key) throw new LibraryError('LIBRARY_KEY_MISSING', 'the library key is missing');
        png = openBytes(key, raw);
      }
      await fs.mkdir(this.deps.workDir, { recursive: true });
      const out = path.join(this.deps.workDir, `lib-${randomBytes(8).toString('hex')}.png`);
      await atomicWriteFile(out, png);
      return out;
    });
  }

  /** Deletes a file that lies inside the work directory. Anything else is refused. */
  async release(absPath: string): Promise<void> {
    const dir = path.resolve(this.deps.workDir);
    const file = path.resolve(absPath);
    if (!file.startsWith(dir + path.sep)) {
      throw new LibraryError('LIBRARY_INVALID', 'only work files can be released');
    }
    await fs.rm(file, { force: true });
  }

  /** Removes leftovers of earlier runs from the work directory (call once at startup). */
  async sweepWorkDir(): Promise<void> {
    await fs.mkdir(this.deps.workDir, { recursive: true });
    for (const name of await fs.readdir(this.deps.workDir)) {
      await fs.rm(path.join(this.deps.workDir, name), { recursive: true, force: true });
    }
  }
}
