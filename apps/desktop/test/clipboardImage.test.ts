import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CLIPBOARD_PNG_BYTES,
  captureClipboardPng,
  isPng,
  type ClipboardImageSource,
} from '../src/main/clipboardImage';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function source(bytes: Uint8Array | null): ClipboardImageSource {
  return { readPng: async () => bytes };
}

describe('isPng', () => {
  it('checks the 8-byte PNG signature', () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false);
    expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false);
  });
});

describe('captureClipboardPng', () => {
  it('returns null when the clipboard holds no image', async () => {
    const written: string[] = [];
    const out = await captureClipboardPng({
      source: source(null),
      dir: '/work',
      write: async (p) => {
        written.push(p);
      },
    });
    expect(out).toBeNull();
    expect(written).toEqual([]);
  });

  it('writes a PNG into the given directory and returns its path', async () => {
    let target = '';
    let data: Uint8Array | null = null;
    const dir = path.join('work', 'dir');
    const out = await captureClipboardPng({
      source: source(PNG),
      dir,
      write: async (p, bytes) => {
        target = p;
        data = bytes;
      },
    });
    expect(out).toBe(target);
    expect(path.dirname(target)).toBe(dir);
    expect(path.basename(target)).toMatch(/^clip-[0-9a-f]{16}\.png$/);
    expect(data).toEqual(PNG);
  });

  it('refuses data that is not a PNG', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const out = await captureClipboardPng({
      source: source(jpeg),
      dir: '/work',
      write: async () => {
        throw new Error('must not write');
      },
    });
    expect(out).toBeNull();
  });

  it('refuses an empty buffer and images above the size limit', async () => {
    const write = async () => {
      throw new Error('must not write');
    };
    expect(
      await captureClipboardPng({ source: source(new Uint8Array()), dir: '/w', write }),
    ).toBeNull();
    const huge = new Uint8Array(MAX_CLIPBOARD_PNG_BYTES + 1);
    huge.set(PNG.subarray(0, 8));
    expect(await captureClipboardPng({ source: source(huge), dir: '/w', write })).toBeNull();
  });
});
