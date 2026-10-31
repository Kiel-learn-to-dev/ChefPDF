/**
 * Path allowlist for the `chef-file` protocol (docs/CONTRACTS.md section 5):
 * files inside the allowed roots (sessions/, cache/) or explicitly granted files
 * (open dialog results, files passed by the OS during this run).
 */
import fs from 'node:fs';
import nodePath from 'node:path';

type PathImpl = typeof nodePath.posix;

export interface AllowlistOptions {
  platform?: NodeJS.Platform;
  /** Resolves symlinks; returns null when the path does not exist. Injectable for tests. */
  realpath?: (p: string) => string | null;
}

function defaultRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

export class PathAllowlist {
  private readonly roots: string[] = [];
  private readonly files = new Set<string>();
  private readonly path: PathImpl;
  private readonly caseInsensitive: boolean;
  private readonly realpath: (p: string) => string | null;

  constructor(roots: string[], options: AllowlistOptions = {}) {
    const platform = options.platform ?? process.platform;
    this.path = platform === 'win32' ? nodePath.win32 : nodePath.posix;
    this.caseInsensitive = platform === 'win32' || platform === 'darwin';
    this.realpath = options.realpath ?? defaultRealpath;
    for (const r of roots) this.addRoot(r);
  }

  addRoot(root: string): void {
    for (const variant of this.variants(root)) {
      if (!this.roots.includes(variant)) this.roots.push(variant);
    }
  }

  /** Grants access to one file (and to its real path when it is a symlink). */
  addFile(file: string): void {
    if (!this.path.isAbsolute(file)) return;
    for (const variant of this.variants(file)) this.files.add(variant);
  }

  /**
   * True when `file` is allowed. Both the lexical path and its resolved real path must be
   * allowed, so a symlink inside an allowed root cannot point outside of it.
   */
  isAllowed(file: string): boolean {
    if (typeof file !== 'string' || !this.path.isAbsolute(file) || file.includes('\0'))
      return false;
    const lexical = this.key(file);
    if (!this.matches(lexical)) return false;
    const real = this.realpath(this.path.resolve(file));
    if (real === null) return false;
    return this.matches(this.key(real));
  }

  private matches(key: string): boolean {
    if (this.files.has(key)) return true;
    return this.roots.some((root) => {
      const rel = this.path.relative(root, key);
      return rel !== '' && !rel.startsWith('..') && !this.path.isAbsolute(rel);
    });
  }

  private variants(p: string): string[] {
    const out = [this.key(p)];
    const real = this.realpath(this.path.resolve(p));
    if (real !== null) {
      const k = this.key(real);
      if (k !== out[0]) out.push(k);
    }
    return out;
  }

  private key(p: string): string {
    const resolved = this.path.resolve(p);
    return this.caseInsensitive ? resolved.toLowerCase() : resolved;
  }
}
