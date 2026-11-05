/** Wheel after a second open (double-click while the app runs): the file goes to the running window,
 * and the mouse wheel must scroll it (bug report 2026-11-04).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { electronBin, launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;

let workDir = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-wheel2-'));
  execFileSync(
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
    { cwd: repoRoot, timeout: 300_000 },
  );
});

test.afterEach(async () => {
  const l = launched;
  launched = null;
  if (!l) return;
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('after a second open of another file, the wheel scrolls that file', async () => {
  test.setTimeout(240_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-wheel2-ud-'));
  launched = await launchApp({
    args: [path.join(workDir, 'contract.pdf')],
    env: { CHEF_CORE_CMD: realCoreCmd },
    userDataDir: userData,
  });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });

  // The second launch hands its file to the running app and exits (single-instance lock).
  const desktop = path.join(repoRoot, 'apps', 'desktop');
  const second = spawn(electronBin, [desktop, path.join(workDir, 'long.pdf')], {
    env: {
      ...process.env,
      CHEF_USER_DATA_DIR: userData,
      CHEF_CORE_CMD: realCoreCmd,
      CHEF_E2E: '1',
      CHEF_E2E_SHOW: '1',
      ELECTRON_RUN_AS_NODE: undefined,
    },
    stdio: 'ignore',
    detached: false,
  });
  await new Promise((resolve) => second.on('exit', resolve));
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  await expect(page.locator('.doctab')).toHaveCount(3);

  const viewer = page.locator('.viewer__scroll');
  const box = await viewer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const before = await viewer.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 800);
  await expect
    .poll(() => viewer.evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBeGreaterThan(before);
});
