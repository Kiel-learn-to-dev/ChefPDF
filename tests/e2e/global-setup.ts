import { execFileSync } from 'node:child_process';
import { desktopDir } from './fixtures/app';
import path from 'node:path';

/** Builds the Electron main/preload bundles once before the suite. */
export default function globalSetup(): void {
  execFileSync(process.execPath, [path.join(desktopDir, 'scripts', 'build.mjs')], {
    cwd: desktopDir,
    stdio: 'inherit',
  });
}
