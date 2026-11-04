/** Page image adjustments (T8.02) UI + Electron shell + the REAL Python core. Skipped if the UI is
 * not built.
 *
 * The erase fixture page is opened. The adjust dialog previews the page (before and after), inverts
 * it, applies, saves, and reads the saved page back: the black block is now light.
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

function py(script: string, ...args: string[]): string {
  return execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(fixturesDir, script), ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 240_000 },
  );
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-adjust-e2e-'));
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

test('a page is previewed before and after, inverted, saved, and the saved page shows the change', async () => {
  test.setTimeout(300_000);
  const source = path.join(workDir, 'adjust-page.pdf');
  py('erase_corpus.py', source);
  const before = JSON.parse(py('erase_check.py', source)) as { blockMean: number };
  expect(before.blockMean).toBeLessThan(60);

  launched = await launchApp({ args: [source], env: { CHEF_CORE_CMD: realCoreCmd } });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Chỉnh ảnh trang');
  await page.getByText('Chỉnh ảnh trang (mức, đường cong, DPI)…', { exact: true }).click();
  const dialog = page.locator('.dlg');
  await expect(dialog.locator('.dlg__title')).toHaveText('Chỉnh ảnh trang');

  await dialog.getByRole('checkbox', { name: 'Đảo màu' }).check();
  await dialog.locator('#adjust-preview-page').fill('1');
  await dialog.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(dialog.locator('.adjust-preview__pair img')).toHaveCount(2, { timeout: 60_000 });

  await dialog.locator('.dlg__footer').getByRole('button', { name: 'Áp dụng chỉnh ảnh' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.doctab__dirty')).toHaveCount(1);

  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
  const after = JSON.parse(py('erase_check.py', source)) as { blockMean: number };
  expect(after.blockMean).toBeGreaterThan(200);
});
