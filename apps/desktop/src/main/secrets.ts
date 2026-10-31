/**
 * Encrypted secret store for remembered PFX passwords (docs/BLUEPRINT.md section 7).
 *
 * - Values are encrypted with Electron `safeStorage` (the OS keychain / DPAPI) before they touch
 *   the disk. The file `<userData>/secrets.json` only holds base64 ciphertext.
 * - The caller's key is an absolute certificate path. It is hashed (SHA-256 of the normalised
 *   path) before it becomes a file key, so the file does not reveal which certificates are used.
 * - PINs are never stored here. This store is for PFX passwords only.
 * - `safeStorage` is injected, so tests run with a fake. Pure Node: no Electron imports.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, isPlainObject, readJsonFile } from './fsutil';

/** The part of Electron's `safeStorage` this store needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export const SECRETS_FILE_VERSION = 1;
export const MAX_SECRET_VALUE_LENGTH = 4096;
/** Owner read/write only, on POSIX systems. */
const SECRETS_FILE_MODE = 0o600;
const HASH_KEY_RE = /^[a-f0-9]{64}$/;

export class SecretsUnavailableError extends Error {
  constructor() {
    super('Secure storage is not available on this computer');
    this.name = 'SecretsUnavailableError';
  }
}

/** File key of a certificate path: SHA-256 of its normalised form (case-folded on Windows / macOS). */
export function secretFileKey(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let normalised = impl.normalize(absPath);
  if (platform === 'win32' || platform === 'darwin') normalised = normalised.toLowerCase();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

interface SecretsFile {
  version: number;
  /** File key (hex SHA-256) -> base64 ciphertext. */
  entries: Record<string, string>;
}

/** Keeps only well-formed entries from untrusted disk data. */
export function sanitizeSecretEntries(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (HASH_KEY_RE.test(key) && typeof value === 'string' && /^[A-Za-z0-9+/=]+$/.test(value)) {
      out[key] = value;
    }
  }
  return out;
}

export class SecretStore {
  private entries: Record<string, string> = {};
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly safeStorage: () => SafeStorageLike | null,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** True when the OS can encrypt. When false the UI must not offer "remember password". */
  available(): boolean {
    const s = this.safeStorage();
    try {
      return s !== null && s.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async set(key: string, value: string): Promise<void> {
    assertKey(key);
    assertValue(value);
    const s = this.usable();
    await this.ensureLoaded();
    this.entries[secretFileKey(key, this.platform)] = s.encryptString(value).toString('base64');
    await this.persist();
  }

  /** The stored plain value, or null when there is none or it cannot be decrypted. */
  async get(key: string): Promise<string | null> {
    assertKey(key);
    if (!this.available()) return null;
    await this.ensureLoaded();
    const cipher = this.entries[secretFileKey(key, this.platform)];
    if (cipher === undefined) return null;
    try {
      return this.safeStorage()!.decryptString(Buffer.from(cipher, 'base64'));
    } catch {
      // Written by another OS account or after a keychain reset: treat as missing.
      return null;
    }
  }

  /** Removes the entry. Works even when encryption is unavailable (nothing is decrypted). */
  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.ensureLoaded();
    const id = secretFileKey(key, this.platform);
    if (!(id in this.entries)) return;
    delete this.entries[id];
    await this.persist();
  }

  /** Resolves when every queued write has reached the disk. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private usable(): SafeStorageLike {
    if (!this.available()) throw new SecretsUnavailableError();
    return this.safeStorage()!;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const res = await readJsonFile(this.file);
    if (res.ok) {
      const body = isPlainObject(res.value) ? res.value : {};
      this.entries = sanitizeSecretEntries(body.entries);
    } else if (!res.missing) {
      // Keep the unreadable file for inspection, then start empty.
      const backup = `${this.file}.corrupt-${this.now().getTime()}`;
      await fs.rename(this.file, backup).catch(() => undefined);
      this.entries = {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const body: SecretsFile = { version: SECRETS_FILE_VERSION, entries: { ...this.entries } };
    const write = this.writeChain.then(() =>
      atomicWriteFile(this.file, JSON.stringify(body, null, 2) + '\n', SECRETS_FILE_MODE),
    );
    this.writeChain = write.catch(() => undefined);
    await write;
  }
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > 32_768 || key.includes('\0')) {
    throw new TypeError('secret key must be a non-empty string');
  }
  if (!path.isAbsolute(key)) throw new TypeError('secret key must be an absolute path');
}

function assertValue(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SECRET_VALUE_LENGTH ||
    value.includes('\0')
  ) {
    throw new TypeError('secret value must be a non-empty string of at most 4096 characters');
  }
}
