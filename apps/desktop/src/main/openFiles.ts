/**
 * Files opened from the OS (A5): command line, second instance, macOS `open-file`.
 * Pure Node: no Electron imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ParseArgsOptions {
  cwd: string;
  /** Leading argv entries to skip: 1 when packaged (exe), 2 in dev (electron + app dir). */
  skip: number;
  isFile?: (p: string) => boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Extracts existing file paths from an argv array. Switches (`-x`, `--x=y`) are ignored,
 * relative paths are resolved against `cwd`, `file://` URLs are accepted, duplicates dropped.
 */
export function parseFileArgs(argv: readonly string[], o: ParseArgsOptions): string[] {
  const isFile = o.isFile ?? defaultIsFile;
  const out: string[] = [];
  for (const raw of argv.slice(o.skip)) {
    if (!raw || raw.startsWith('-')) continue;
    let candidate = raw;
    if (/^file:\/\//i.test(raw)) {
      try {
        candidate = fileURLToPath(raw);
      } catch {
        continue;
      }
    }
    const abs = path.resolve(o.cwd, candidate);
    if (!out.includes(abs) && isFile(abs)) out.push(abs);
  }
  return out;
}

/** Number of argv entries before user arguments. */
export function argvSkipCount(isPackaged: boolean, defaultApp: boolean): number {
  return isPackaged || !defaultApp ? 1 : 2;
}

/**
 * Collects OS-provided files. Before the renderer has loaded they accumulate into
 * `initialFiles`; afterwards they are delivered through `deliver` as `open-files` events.
 */
export class OpenFilesController {
  private readonly initial: string[] = [];
  private deliver: ((paths: string[]) => void) | null = null;

  constructor(private readonly grant: (file: string) => void) {}

  get initialFiles(): string[] {
    return [...this.initial];
  }

  /** Called once the main window's renderer is ready to receive events. */
  attach(deliver: (paths: string[]) => void): void {
    this.deliver = deliver;
  }

  detach(): void {
    this.deliver = null;
  }

  add(paths: string[]): void {
    const fresh = paths.filter((p) => path.isAbsolute(p));
    if (fresh.length === 0) return;
    for (const p of fresh) this.grant(p);
    if (this.deliver) {
      this.deliver(fresh);
    } else {
      for (const p of fresh) if (!this.initial.includes(p)) this.initial.push(p);
    }
  }
}
