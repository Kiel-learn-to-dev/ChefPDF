/**
 * Clipboard image (M4): the PNG on the clipboard is saved to the work directory, so the core can
 * read it by path (imagesToPdf). Electron is reached only through the ClipboardImageSource
 * interface, so the rules below are unit-tested without Electron.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_CLIPBOARD_PNG_BYTES = 50 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The part of Electron's clipboard used here: the PNG bytes of the first image on the clipboard,
 * or null when there is none (Electron 45 exposes the clipboard as ClipboardItem list).
 */
export interface ClipboardImageSource {
  readPng(): Promise<Uint8Array | null>;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export interface CaptureDeps {
  source: ClipboardImageSource;
  /** Directory for the PNG (the library work directory). */
  dir: string;
  /** Writes the file; injected in tests. */
  write?(absPath: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Saves the clipboard image as a PNG file and returns its path, or null when the clipboard holds
 * no image, or the data is not a PNG of a sane size.
 */
export async function captureClipboardPng(deps: CaptureDeps): Promise<string | null> {
  const png = await deps.source.readPng();
  if (!png) return null;
  if (png.byteLength === 0 || png.byteLength > MAX_CLIPBOARD_PNG_BYTES) return null;
  if (!isPng(png)) return null;
  const write =
    deps.write ??
    (async (absPath: string, bytes: Uint8Array) => {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, bytes);
    });
  const out = path.join(deps.dir, `clip-${randomBytes(8).toString('hex')}.png`);
  await write(out, png);
  return out;
}
