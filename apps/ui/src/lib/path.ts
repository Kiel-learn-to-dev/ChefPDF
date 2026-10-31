/** Minimal path helpers that work for both POSIX and Windows paths (renderer has no `path`). */

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return p[0]!;
  // Keep "C:\" as is.
  if (i === 2 && p[1] === ':') return p.slice(0, 3);
  return p.slice(0, i);
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function separatorOf(p: string): '/' | '\\' {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export function join(dir: string, name: string): string {
  if (!dir) return name;
  const sep = separatorOf(dir);
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep + name;
}

/** "a.pdf" -> "a (2).pdf"-style suffix helper: "a.pdf" + "_trich" -> "a_trich.pdf". */
export function withSuffix(p: string, suffix: string, ext = '.pdf'): string {
  return join(dirname(p), stripExt(basename(p)) + suffix + ext);
}
