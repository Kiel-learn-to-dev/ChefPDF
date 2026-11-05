/** Mouse wheel scrolls the viewer (bug report 2026-11-04). Measured on the scroll position of the
 * viewer, for a long text PDF and a long image-only (scanned) PDF, both opened from the command line.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;

let workDir = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-wheel-'));
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

for (const name of ['long.pdf', 'scan_long.pdf']) {
  test(`the mouse wheel scrolls ${name} opened from the command line`, async () => {
    test.setTimeout(180_000);
    // Off screen like every test window (D51): the wheel goes through the page protocol.
    launched = await launchApp({
      args: [path.join(workDir, name)],
      env: { CHEF_CORE_CMD: realCoreCmd },
    });
    const page = launched.page;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
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
}
