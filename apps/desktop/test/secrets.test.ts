import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SecretStore,
  SecretsUnavailableError,
  sanitizeSecretEntries,
  secretFileKey,
  type SafeStorageLike,
} from '../src/main/secrets';
import { validateSecretKey, validateSecretValue } from '../src/main/validate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-secrets-'));
  dirs.push(dir);
  return dir;
}

/** Fake safeStorage: XOR "encryption", so the ciphertext never contains the plain text. */
function fakeSafe(available = true): SafeStorageLike {
  const xor = (buf: Buffer) => Buffer.from(Array.from(buf, (b) => b ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => xor(Buffer.from(text, 'utf8')),
    decryptString: (buf) => xor(buf).toString('utf8'),
  };
}

const certPath = (dir: string, name = 'chu-ky.pfx') => path.join(dir, name);

describe('SecretStore', () => {
  it('round-trips a value and keeps it after a reload', async () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 'secrets.json'), () => fakeSafe());
    await store.set(certPath(dir), 'mat-khau-123');
    expect(await store.get(certPath(dir))).toBe('mat-khau-123');
    const again = new SecretStore(path.join(dir, 'secrets.json'), () => fakeSafe());
    expect(await again.get(certPath(dir))).toBe('mat-khau-123');
  });

  it('returns null for a key that was never set', async () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 'secrets.json'), () => fakeSafe());
    expect(await store.get(certPath(dir))).toBeNull();
    await store.delete(certPath(dir)); // no error for a missing key
    expect(await store.get(certPath(dir))).toBeNull();
  });

  it('deletes a value', async () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 'secrets.json'), () => fakeSafe());
    await store.set(certPath(dir), 'x-secret');
    await store.delete(certPath(dir));
    expect(await store.get(certPath(dir))).toBeNull();
  });

  it('reports unavailable encryption and refuses to store', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secrets.json');
    const store = new SecretStore(file, () => fakeSafe(false));
    expect(store.available()).toBe(false);
    await expect(store.set(certPath(dir), 'x')).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(await store.get(certPath(dir))).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('treats a missing safeStorage module as unavailable', async () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 'secrets.json'), () => null);
    expect(store.available()).toBe(false);
    await expect(store.set(certPath(dir), 'x')).rejects.toBeInstanceOf(SecretsUnavailableError);
  });

  it('treats a throwing isEncryptionAvailable as unavailable', () => {
    const dir = tmpDir();
    const broken: SafeStorageLike = {
      isEncryptionAvailable: () => {
        throw new Error('keychain locked');
      },
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    };
    expect(new SecretStore(path.join(dir, 's.json'), () => broken).available()).toBe(false);
  });

  it('never writes the plain password to the file', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secrets.json');
    const store = new SecretStore(file, () => fakeSafe());
    await store.set(certPath(dir), 'Mat-khau-Bi-Mat-99');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('Mat-khau-Bi-Mat-99');
    expect(raw).not.toContain('chu-ky.pfx');
    expect(raw).not.toContain(dir);
  });

  it('hashes the certificate path into the file key', () => {
    const a = secretFileKey('C:\\Users\\A\\chu-ky.pfx', 'win32');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    // Same file, different letter case on Windows: same key.
    expect(secretFileKey('C:\\USERS\\a\\CHU-KY.pfx', 'win32')).toBe(a);
    // Different file: different key.
    expect(secretFileKey('C:\\Users\\A\\khac.pfx', 'win32')).not.toBe(a);
    // Linux paths are case-sensitive.
    expect(secretFileKey('/home/a/x.pfx', 'linux')).not.toBe(
      secretFileKey('/home/a/X.pfx', 'linux'),
    );
  });

  it('writes the secrets file with owner-only permissions on POSIX', async () => {
    if (process.platform === 'win32') return;
    const dir = tmpDir();
    const file = path.join(dir, 'secrets.json');
    await new SecretStore(file, () => fakeSafe()).set(certPath(dir), 'x-secret');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes atomically: no temporary files are left behind', async () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 'secrets.json'), () => fakeSafe());
    await store.set(certPath(dir, 'a.pfx'), 'one-secret');
    await store.set(certPath(dir, 'b.pfx'), 'two-secret');
    await store.flush();
    expect(fs.readdirSync(dir).sort()).toEqual(['secrets.json']);
  });

  it('keeps every write when several are queued at once', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secrets.json');
    const store = new SecretStore(file, () => fakeSafe());
    await Promise.all([
      store.set(certPath(dir, 'a.pfx'), 'pw-a'),
      store.set(certPath(dir, 'b.pfx'), 'pw-b'),
      store.set(certPath(dir, 'c.pfx'), 'pw-c'),
    ]);
    const again = new SecretStore(file, () => fakeSafe());
    expect(await again.get(certPath(dir, 'a.pfx'))).toBe('pw-a');
    expect(await again.get(certPath(dir, 'b.pfx'))).toBe('pw-b');
    expect(await again.get(certPath(dir, 'c.pfx'))).toBe('pw-c');
  });

  it('tolerates a corrupted file: starts empty, keeps a backup, and can write again', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secrets.json');
    fs.writeFileSync(file, '{ not json');
    const store = new SecretStore(
      file,
      () => fakeSafe(),
      'linux',
      () => new Date(1700000000000),
    );
    expect(await store.get(certPath(dir))).toBeNull();
    expect(fs.existsSync(`${file}.corrupt-1700000000000`)).toBe(true);
    await store.set(certPath(dir), 'fresh-secret');
    expect(await store.get(certPath(dir))).toBe('fresh-secret');
  });

  it('returns null when a stored value cannot be decrypted', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secrets.json');
    await new SecretStore(file, () => fakeSafe()).set(certPath(dir), 'pw');
    const broken: SafeStorageLike = {
      ...fakeSafe(),
      decryptString: () => {
        throw new Error('decrypt failed');
      },
    };
    expect(await new SecretStore(file, () => broken).get(certPath(dir))).toBeNull();
  });

  it('rejects relative keys and empty or oversized values', async () => {
    const dir = tmpDir();
    const store = new SecretStore(path.join(dir, 'secrets.json'), () => fakeSafe());
    await expect(store.set('chu-ky.pfx', 'x')).rejects.toThrow(/absolute/);
    await expect(store.set(certPath(dir), '')).rejects.toThrow(/non-empty/);
    await expect(store.set(certPath(dir), 'x'.repeat(4097))).rejects.toThrow(/4096/);
    await expect(store.get('relative')).rejects.toThrow(/absolute/);
  });
});

describe('sanitizeSecretEntries', () => {
  it('keeps only hex keys with base64 values', () => {
    const good = 'a'.repeat(64);
    expect(
      sanitizeSecretEntries({
        [good]: 'YWJj',
        short: 'YWJj',
        ['b'.repeat(64)]: 42,
        ['c'.repeat(64)]: 'not base64!',
      }),
    ).toEqual({ [good]: 'YWJj' });
    expect(sanitizeSecretEntries(['x'])).toEqual({});
    expect(sanitizeSecretEntries(null)).toEqual({});
  });
});

describe('IPC validators for secrets', () => {
  it('accepts absolute keys and bounded non-empty values', () => {
    expect(validateSecretKey(path.resolve('chu-ky.pfx'))).toBe(
      path.normalize(path.resolve('chu-ky.pfx')),
    );
    expect(() => validateSecretKey('chu-ky.pfx')).toThrow();
    expect(() => validateSecretKey(42)).toThrow();
    expect(validateSecretValue('mat-khau')).toBe('mat-khau');
    expect(() => validateSecretValue('')).toThrow();
    expect(() => validateSecretValue('a\u0000b')).toThrow();
    expect(() => validateSecretValue('x'.repeat(4097))).toThrow();
  });
});
