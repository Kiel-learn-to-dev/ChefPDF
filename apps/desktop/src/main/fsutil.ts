import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Writes `data` atomically: temp file in the same directory, fsync, then rename.
 * `mode` sets the permission bits of the new file (POSIX only; Windows ignores them).
 */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  const handle = await fs.open(tmp, 'w', mode);
  try {
    await handle.writeFile(data, typeof data === 'string' ? 'utf8' : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readJsonFile(
  file: string,
): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { ok: false, missing: true };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, missing: false };
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}
