import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChefLibrary,
  LibraryError,
  MAX_LIBRARY_ITEMS,
  openBytes,
  sanitizeLibraryIndex,
  sealBytes,
  type LibraryKeyStore,
} from '../src/main/library';
import { validateLibraryAddInput, validateLibraryId } from '../src/main/validate';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG-looking payload with a recognisable marker, so tests can search for it on disk. */
const pngBytes = (marker = 'MARKER-ink-stroke') =>
  Buffer.concat([PNG_SIG, Buffer.from(`${marker}-${randomBytes(32).toString('hex')}`)]);

function setup(opts: { encrypt?: boolean; keys?: LibraryKeyStore } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-library-'));
  dirs.push(root);
  const dir = path.join(root, 'library');
  const workDir = path.join(root, 'cache', 'sigwork');
  let stored: Buffer | null = null;
  const keys: LibraryKeyStore = opts.keys ?? {
    load: async () => stored,
    save: async (k) => {
      stored = Buffer.from(k);
    },
  };
  const make = (encrypt = opts.encrypt ?? true, store = keys) =>
    new ChefLibrary({
      dir,
      workDir,
      encrypt,
      keys: store,
      now: () => new Date('2026-10-31T08:00:00Z'),
    });
  return { root, dir, workDir, keys, make, library: make() };
}

describe('sealing (AES-256-GCM)', () => {
  it('round-trips bytes with the same key', () => {
    const key = randomBytes(32);
    const plain = pngBytes();
    expect(openBytes(key, sealBytes(key, plain)).equals(plain)).toBe(true);
  });

  it('detects any change of the sealed bytes (GCM tag)', () => {
    const key = randomBytes(32);
    const sealed = sealBytes(key, pngBytes());
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1]! ^= 0x01;
    expect(() => openBytes(key, flipped)).toThrow(/authentication|tampered/);
    const otherKey = randomBytes(32);
    expect(() => openBytes(otherKey, sealed)).toThrow(LibraryError);
    expect(() => openBytes(key, Buffer.from('not sealed at all, really'))).toThrow(LibraryError);
  });
});

describe('ChefLibrary', () => {
  it('adds, lists, reads, renames and removes an encrypted item', async () => {
    const { library, dir } = setup();
    const plain = pngBytes();
    const item = await library.add({ kind: 'signature', name: '  Chữ ký Nam  ', bytes: plain });
    expect(item).toMatchObject({
      name: 'Chữ ký Nam',
      kind: 'signature',
      createdAt: '2026-10-31T08:00:00.000Z',
    });
    expect(await library.list()).toEqual([item]);
    expect((await library.get(item.id)).equals(plain)).toBe(true);

    const renamed = await library.rename(item.id, 'Con dấu');
    expect(renamed.name).toBe('Con dấu');

    await library.remove(item.id);
    expect(await library.list()).toEqual([]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.enc'))).toEqual([]);
  });

  it('keeps no plaintext PNG bytes on disk when encryption is on', async () => {
    const { library, dir } = setup({ encrypt: true });
    const marker = 'SECRET-SIGNATURE-PIXELS';
    await library.add({ kind: 'signature', name: 'Chữ ký', bytes: pngBytes(marker) });
    const files = fs.readdirSync(dir);
    const sealed = files.find((f) => f.endsWith('.enc'))!;
    const raw = fs.readFileSync(path.join(dir, sealed));
    expect(raw.includes(PNG_SIG)).toBe(false);
    expect(raw.includes(Buffer.from(marker))).toBe(false);
    // The index holds names and ids only.
    const index = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    expect(index).toContain('Chữ ký');
    expect(index).not.toContain(marker);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('stores plain PNG files when secure storage is unavailable', async () => {
    const { make, dir } = setup({ encrypt: false });
    const library = make(false);
    expect(await library.status()).toEqual({ encrypted: false });
    const bytes = pngBytes('PLAIN');
    const item = await library.add({ kind: 'stamp', name: 'Dấu', bytes });
    const file = fs.readdirSync(dir).find((f) => f === `${item.id}.png`)!;
    expect(fs.readFileSync(path.join(dir, file)).equals(bytes)).toBe(true);
  });

  it('reports a missing key instead of returning garbage', async () => {
    const { make, keys, library } = setup();
    const item = await library.add({ kind: 'signature', name: 'A', bytes: pngBytes() });
    const withoutKey = make(true, { load: async () => null, save: keys.save });
    await expect(withoutKey.get(item.id)).rejects.toMatchObject({ code: 'LIBRARY_KEY_MISSING' });
    // Adding would start a second key and orphan the sealed items: refused too.
    await expect(
      withoutKey.add({ kind: 'signature', name: 'B', bytes: pngBytes() }),
    ).rejects.toMatchObject({
      code: 'LIBRARY_KEY_MISSING',
    });
  });

  it('reuses the stored key for every item', async () => {
    let saves = 0;
    let stored: Buffer | null = null;
    const keys: LibraryKeyStore = {
      load: async () => stored,
      save: async (k) => {
        saves++;
        stored = Buffer.from(k);
      },
    };
    const { make } = setup({ keys });
    const library = make(true, keys);
    await library.add({ kind: 'signature', name: 'A', bytes: pngBytes() });
    await library.add({ kind: 'signature', name: 'B', bytes: pngBytes() });
    expect(saves).toBe(1);
  });

  it('refuses non-PNG bytes, bad names, unknown kinds and a full library', async () => {
    const { library } = setup();
    await expect(
      library.add({ kind: 'signature', name: 'x', bytes: Buffer.from('JPEG-ish') }),
    ).rejects.toMatchObject({ code: 'LIBRARY_INVALID' });
    await expect(
      library.add({ kind: 'signature', name: '   ', bytes: pngBytes() }),
    ).rejects.toMatchObject({
      code: 'LIBRARY_INVALID',
    });
    await expect(
      library.add({ kind: 'photo' as never, name: 'x', bytes: pngBytes() }),
    ).rejects.toMatchObject({ code: 'LIBRARY_INVALID' });
    await expect(library.get('0'.repeat(32))).rejects.toMatchObject({ code: 'LIBRARY_NOT_FOUND' });
    expect(MAX_LIBRARY_ITEMS).toBe(200);
  });

  it('starts with an empty list after a corrupt index and keeps the broken file', async () => {
    const { dir, make } = setup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json');
    expect(await make().list()).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('index.json.corrupt-'))).toBe(true);
  });

  it('materialises a decrypted PNG in the work dir and releases only work files', async () => {
    const { library, workDir } = setup();
    const plain = pngBytes('WORK');
    const item = await library.add({ kind: 'logo', name: 'Logo', bytes: plain });
    const out = await library.materialize(item.id);
    expect(path.dirname(out)).toBe(workDir);
    expect(fs.readFileSync(out).equals(plain)).toBe(true);
    await library.release(out);
    expect(fs.existsSync(out)).toBe(false);
    await expect(library.release(path.join(os.tmpdir(), 'not-ours.png'))).rejects.toMatchObject({
      code: 'LIBRARY_INVALID',
    });
  });

  it('sweeps leftovers of earlier runs from the work dir', async () => {
    const { library, workDir } = setup();
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'old.png'), 'x');
    await library.sweepWorkDir();
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it('removes the index entry when the file cannot be written', async () => {
    const { library, dir } = setup();
    await library.add({ kind: 'signature', name: 'Đầu tiên', bytes: pngBytes() });
    // Make the index unwritable by replacing it with a directory: the next add must roll back.
    fs.rmSync(path.join(dir, 'index.json'));
    fs.mkdirSync(path.join(dir, 'index.json'));
    await expect(
      library.add({ kind: 'signature', name: 'Thứ hai', bytes: pngBytes() }),
    ).rejects.toThrow();
    expect((await library.list()).map((i) => i.name)).toEqual(['Đầu tiên']);
  });
});

describe('sanitizeLibraryIndex', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const good = {
      id: 'a'.repeat(32),
      name: 'Chữ ký',
      kind: 'signature',
      createdAt: '2026-10-31T08:00:00.000Z',
      encrypted: true,
    };
    const out = sanitizeLibraryIndex({
      items: [
        good,
        { ...good, id: 'a'.repeat(32) },
        { ...good, id: 'short' },
        { ...good, id: 'b'.repeat(32), name: '' },
        { ...good, id: 'c'.repeat(32), kind: 'photo' },
        { ...good, id: 'd'.repeat(32), createdAt: 'yesterday' },
        { ...good, id: 'e'.repeat(32), encrypted: 'yes' },
        { ...good, id: 'f'.repeat(32), name: 'x'.repeat(81) },
        'junk',
      ],
    });
    expect(out).toEqual([good]);
    expect(sanitizeLibraryIndex(null)).toEqual([]);
    expect(sanitizeLibraryIndex({ items: 'x' })).toEqual([]);
  });
});

describe('IPC validators for the library', () => {
  it('accepts exactly one source of image data', () => {
    expect(validateLibraryAddInput({ kind: 'stamp', name: 'a', path: '/tmp/a.png' }).path).toBe(
      path.normalize('/tmp/a.png'),
    );
    expect(
      validateLibraryAddInput({ kind: 'stamp', name: 'a', bytes: new Uint8Array([1]) }).bytes,
    ).toBeInstanceOf(Uint8Array);
    expect(() => validateLibraryAddInput({ kind: 'stamp', name: 'a' })).toThrow(/exactly one/);
    expect(() =>
      validateLibraryAddInput({
        kind: 'stamp',
        name: 'a',
        path: '/x.png',
        bytes: new Uint8Array(),
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      validateLibraryAddInput({ kind: 'stamp', name: 'a', path: 'relative.png' }),
    ).toThrow();
  });

  it('accepts only 32-character hex ids', () => {
    expect(validateLibraryId('a'.repeat(32))).toBe('a'.repeat(32));
    expect(() => validateLibraryId('../index')).toThrow(/invalid/);
    expect(() => validateLibraryId('A'.repeat(32))).toThrow(/invalid/);
  });
});
