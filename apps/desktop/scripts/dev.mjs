// Development runner: UI Vite dev server + esbuild watch + Electron (restarted on rebuild).
// Usage: pnpm dev   (from the repo root)   [--no-ui]
// Env: CHEF_DEV_SERVER_URL to use an already running dev server.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchAll } from './build.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '../..');
const require = createRequire(import.meta.url);
const electronBin = require('electron');
const DEFAULT_URL = 'http://localhost:5173';
const isWin = process.platform === 'win32';

let uiServer = null;
let electron = null;
let restarting = false;
let shuttingDown = false;

async function waitForUrl(url, timeoutMs, isAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) return false;
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function startUi() {
  if (process.env.CHEF_DEV_SERVER_URL) return process.env.CHEF_DEV_SERVER_URL;
  if (process.argv.includes('--no-ui')) return undefined;
  let alive = true;
  uiServer = spawn(isWin ? 'pnpm.cmd' : 'pnpm', ['--filter', '@chef/ui', 'dev'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWin,
  });
  uiServer.on('exit', (code) => {
    alive = false;
    uiServer = null;
    if (!shuttingDown) console.warn(`[dev] UI dev server exited (code ${code})`);
  });
  const ok = await waitForUrl(DEFAULT_URL, 60_000, () => alive);
  if (!ok) {
    console.warn('[dev] UI dev server not available; Electron will show the fallback page.');
    return undefined;
  }
  return DEFAULT_URL;
}

function launchElectron(devServerUrl) {
  const args = ['.'];
  // Chromium refuses to run as root with its sandbox (containers); dev convenience only.
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const env = { ...process.env, NODE_ENV: 'development' };
  if (devServerUrl) env.CHEF_DEV_SERVER_URL = devServerUrl;
  else delete env.CHEF_DEV_SERVER_URL;
  electron = spawn(electronBin, args, { cwd: desktopDir, stdio: 'inherit', env });
  electron.on('exit', (code) => {
    electron = null;
    if (restarting) {
      restarting = false;
      launchElectron(devServerUrl);
    } else {
      shutdown(code ?? 0);
    }
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  electron?.kill();
  if (uiServer) {
    if (isWin) spawn('taskkill', ['/pid', String(uiServer.pid), '/t', '/f']);
    else uiServer.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const devServerUrl = await startUi();
let first = true;
await watchAll(() => {
  if (first) {
    first = false;
    launchElectron(devServerUrl);
  } else if (electron) {
    console.log('[dev] main/preload rebuilt; restarting Electron');
    restarting = true;
    electron.kill();
  }
});
