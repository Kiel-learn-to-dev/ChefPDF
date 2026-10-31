#!/usr/bin/env node
// Builds the Python core as a PyInstaller onedir bundle: packaging/dist/chef-core/chef-core[.exe]
// electron-builder copies that folder to <resources>/core/ (apps/desktop/electron-builder.yml).
// Usage: node packaging/build-core.mjs
// Requires uv; PyInstaller is pulled in ephemerally (core/pyproject.toml is not modified).
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, '..');
const distDir = path.join(packagingDir, 'dist');
const workDir = path.join(packagingDir, 'build');
const outDir = path.join(distDir, 'chef-core');
const exe = path.join(outDir, process.platform === 'win32' ? 'chef-core.exe' : 'chef-core');

// Pinned so release builds are reproducible.
const PYINSTALLER = 'pyinstaller==6.22.3';

const args = [
  'run',
  '--project',
  'core',
  '--no-dev',
  '--with',
  PYINSTALLER,
  'pyinstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--console', // stdio is the JSON-RPC channel; the window is hidden by the spawner
  '--name',
  'chef-core',
  '--distpath',
  distDir,
  '--workpath',
  path.join(workDir, 'work'),
  '--specpath',
  workDir,
  '--paths',
  path.join(repoRoot, 'core'),
  // Ops are registered from submodules that may be imported dynamically.
  '--collect-submodules',
  'chef_core',
  '--copy-metadata',
  'chef-core',
  path.join(packagingDir, 'core-entry.py'),
];

rmSync(outDir, { recursive: true, force: true });
console.log(`[build-core] uv ${args.join(' ')}`);
const res = spawnSync('uv', args, { cwd: repoRoot, stdio: 'inherit', shell: false });
if (res.error) {
  console.error(`[build-core] failed to run uv: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) process.exit(res.status ?? 1);
if (!existsSync(exe)) {
  console.error(`[build-core] expected executable not found: ${exe}`);
  process.exit(1);
}
console.log(`[build-core] built ${exe}`);
