/**
 * B2 (bug report 2026-11-04), the case the report describes and the plain wheel spec does not cover:
 * Chef is NOT the active window, another window is on top of it, and the owner's real mouse wheel
 * goes to the viewer under the cursor. The wheel is an OS gesture (fixtures/b2_os_wheel.ps1), not
 * Playwright's synthetic one, and the other window is a small TopMost window over the top strip of
 * Chef, so the viewer area under the cursor is not covered. Requires the packaged exe when
 * CHEF_E2E_EXE is set (the gate); dev otherwise. Windows only.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const topScript = path.join(fixturesDir, 'b2_top_window.ps1');
const wheelScript = path.join(fixturesDir, 'b2_os_wheel.ps1');

let workDir = '';
let launched: Launched | null = null;
let topWindow: ChildProcess | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(process.platform !== 'win32', 'B2 OS wheel is Windows only');
test.skip(!uiBuilt && !process.env.CHEF_E2E_EXE, 'UI not built (run pnpm --filter @chef/ui build)');

function powershell(args: string[]): string {
  const out = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    {
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (out.status !== 0)
    throw new Error(`powershell ${args[0]} exited ${out.status}: ${out.stderr}`);
  return out.stdout;
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-b2-top-'));
  spawnSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(fixturesDir, 'wheel_corpus.py'),
      workDir,
    ],
    {
      cwd: repoRoot,
      timeout: 300_000,
    },
  );
});

test.afterEach(async () => {
  const l = launched;
  launched = null;
  if (topWindow && topWindow.exitCode === null) topWindow.kill();
  topWindow = null;
  if (!l) return;
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('B2: with another window on top, the real wheel over Chef scrolls the long file', async () => {
  test.setTimeout(240_000);
  launched = await launchUnderTest({
    args: [path.join(workDir, 'long.pdf')],
    env: { CHEF_CORE_CMD: realCoreCmd },
    visible: true,
  });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  await page.waitForTimeout(500);

  // Window geometry in screen pixels: outer frame from window.screen*, content offset from the
  // difference between outer and inner size, and the device scale for SetCursorPos.
  const geo = await page.evaluate(() => ({
    left: window.screenX,
    top: window.screenY,
    outerW: window.outerWidth,
    outerH: window.outerHeight,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  const contentLeft = geo.left + (geo.outerW - geo.innerW) / 2;
  const contentTop = geo.top + (geo.outerH - geo.innerH);
  const viewer = page.locator('.viewer__scroll');
  const box = await viewer.boundingBox();
  expect(box).not.toBeNull();
  const targetX = Math.round((contentLeft + box!.x + box!.width / 2) * geo.dpr);
  const targetY = Math.round((contentTop + box!.y + box!.height / 2) * geo.dpr);
  // The other window covers the top strip of Chef (title bar and tabs), never the viewer.
  const coverTop = Math.round(geo.top * geo.dpr);
  const coverH = Math.round((contentTop - geo.top + 56) * geo.dpr);
  expect(targetY).toBeGreaterThan(coverTop + coverH);

  const stop = path.join(workDir, 'top-window.stop');
  topWindow = spawn(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      topScript,
      '-X',
      String(Math.round(geo.left * geo.dpr)),
      '-Y',
      String(coverTop),
      '-W',
      String(Math.round(380 * geo.dpr)),
      '-H',
      String(coverH),
      '-Stop',
      stop,
    ],
    { stdio: 'ignore' },
  );
  // Let the other window come up and take the focus before the wheel.
  await page.waitForTimeout(2_000);

  const before = await viewer.evaluate((el) => el.scrollTop);
  powershell([
    '-File',
    wheelScript,
    '-X',
    String(targetX),
    '-Y',
    String(targetY),
    '-Delta',
    '-600',
  ]);
  await expect
    .poll(() => viewer.evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBeGreaterThan(before);

  // Control: the same gesture over the strip covered by the other window must not scroll Chef.
  const afterWheel = await viewer.evaluate((el) => el.scrollTop);
  powershell([
    '-File',
    wheelScript,
    '-X',
    String(targetX),
    '-Y',
    String(coverTop + 10),
    '-Delta',
    '-600',
  ]);
  await page.waitForTimeout(1_000);
  expect(await viewer.evaluate((el) => el.scrollTop)).toBe(afterWheel);

  fs.writeFileSync(stop, 'stop');
});
