/** Spine adjustment (T8.08) UI + Electron shell + the REAL Python core. Skipped if the UI is not built.
 *
 * A two-page spread is opened. The automatic spine is previewed, moved by hand, and the spread is
 * split at that position. The saved file is read back independently: two pages, the left page
 * (red marker) first, the right page (blue marker) second.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-spine-e2e-'));
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

function readBack(file: string): { pages: number; markers: (string | null)[] } {
  const output = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(fixturesDir, 'spine_check.py'), file],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  return JSON.parse(output) as { pages: number; markers: (string | null)[] };
}

test('a spread is previewed, the spine is moved by hand, and the split keeps the page order', async () => {
  const source = path.join(workDir, 'spread.pdf');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(fixturesDir, 'spine_corpus.py'),
      source,
    ],
    { cwd: repoRoot, timeout: 120_000 },
  );
  launched = await launchApp({ args: [source], env: { CHEF_CORE_CMD: realCoreCmd } });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Chỉnh khe gáy');
  await page.getByText('Chỉnh khe gáy (tách trang đôi)…', { exact: true }).click();
  const dialog = page.locator('.dlg');
  await expect(dialog.locator('.dlg__title')).toHaveText('Chỉnh khe gáy');

  // The automatic spine is shown on the preview, with its position and confidence.
  await dialog.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(dialog.locator('.spine-preview__frame img')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.locator('.spine-preview__meta')).toContainText('Khe gáy tự dò: 50');

  // Manual mode: the slider starts at the automatic position; move it to 40 %.
  await dialog.getByRole('radio', { name: 'Chỉnh tay' }).check();
  const slider = dialog.getByRole('slider');
  await expect(slider).toHaveValue('50');
  await slider.fill('40');
  await expect(dialog.locator('.spine-preview__line')).toHaveAttribute('style', /left: 40/);

  await dialog.locator('.dlg__footer').getByRole('button', { name: 'Tách trang đôi' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.doctab__dirty')).toHaveCount(1);

  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
  // The split is done at 40 %: the left page has the red marker, the right page the blue one.
  expect(readBack(source)).toEqual({ pages: 2, markers: ['red', 'blue'] });
});
