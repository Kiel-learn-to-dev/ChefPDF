/**
 * Saved list of certificate files (T3.04): add, remove, mark as remembered. Pure. Paths are
 * compared case-insensitively on Windows and macOS, like the main process does.
 */
import type { KnownPfxFile } from '@chef/contracts';

export const MAX_KNOWN_PFX = 20;

/** The file name of a path, for both Windows and POSIX separators. */
export function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export interface PathCompare {
  caseInsensitive: boolean;
}

export function samePath(a: string, b: string, cmp: PathCompare): boolean {
  return cmp.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function findKnownPfx(
  list: readonly KnownPfxFile[],
  filePath: string,
  cmp: PathCompare,
): KnownPfxFile | undefined {
  return list.find((e) => samePath(e.path, filePath, cmp));
}

/**
 * Puts `filePath` at the front of the list (most recent first). An existing entry keeps its
 * label and remembered flag unless `patch` overrides them. The list is capped at MAX_KNOWN_PFX.
 */
export function upsertKnownPfx(
  list: readonly KnownPfxFile[],
  filePath: string,
  cmp: PathCompare,
  patch: Partial<Pick<KnownPfxFile, 'label' | 'remembered'>> = {},
): KnownPfxFile[] {
  const previous = findKnownPfx(list, filePath, cmp);
  const entry: KnownPfxFile = {
    path: filePath,
    label: patch.label ?? previous?.label ?? fileNameOf(filePath),
    remembered: patch.remembered ?? previous?.remembered ?? false,
  };
  const rest = list.filter((e) => !samePath(e.path, filePath, cmp));
  return [entry, ...rest].slice(0, MAX_KNOWN_PFX);
}

export function removeKnownPfx(
  list: readonly KnownPfxFile[],
  filePath: string,
  cmp: PathCompare,
): KnownPfxFile[] {
  return list.filter((e) => !samePath(e.path, filePath, cmp));
}

export function setRemembered(
  list: readonly KnownPfxFile[],
  filePath: string,
  remembered: boolean,
  cmp: PathCompare,
): KnownPfxFile[] {
  return list.map((e) => (samePath(e.path, filePath, cmp) ? { ...e, remembered } : e));
}
