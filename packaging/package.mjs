#!/usr/bin/env node
// Builds installers for the current OS: core (PyInstaller) -> UI (Vite) -> main/preload
// (esbuild) -> electron-builder. Output: apps/desktop/release/.
// Usage: node packaging/package.mjs [--skip-core] [--skip-ui] [-- <electron-builder args>]
//   e.g. `pnpm package -- --arm64`, `pnpm package -- --linux AppImage`
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const isWin = process.platform === 'win32';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const builderArgs = sep >= 0 ? argv.slice(sep + 1) : [];

function run(cmd, args, cwd = repoRoot) {
  console.log(`\n[package] ${cmd} ${args.join(' ')}`);
  // .cmd shims need a shell on Windows; plain executables (node) must not get one (paths with spaces).
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin && cmd.endsWith('.cmd') });
  if (res.status !== 0) {
    console.error(`[package] step failed: ${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

const pnpm = isWin ? 'pnpm.cmd' : 'pnpm';

if (!own.includes('--skip-core'))
  run(process.execPath, [path.join(packagingDir, 'build-core.mjs')]);
if (!own.includes('--skip-ui')) run(pnpm, ['--filter', '@chef/ui', 'build']);
else if (!existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'))) {
  console.warn('[package] apps/ui/dist missing: the packaged app will show the fallback page');
}
run(pnpm, ['--filter', '@chef/desktop', 'build']);
run(
  pnpm,
  [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.yml',
    '--publish',
    'never',
    ...builderArgs,
  ],
  desktopDir,
);

const releaseDir = path.join(desktopDir, 'release');
console.log('\n[package] artifacts:');
for (const f of readdirSync(releaseDir)) {
  const p = path.join(releaseDir, f);
  const st = statSync(p);
  if (st.isFile() && !f.endsWith('.blockmap') && !f.endsWith('.yml') && !f.endsWith('.yaml')) {
    console.log(`  ${(st.size / 1024 / 1024).toFixed(1).padStart(7)} MB  ${f}`);
  }
}
