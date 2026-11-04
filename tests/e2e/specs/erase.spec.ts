/** Erase areas and colour stains (T8.03) UI + Electron shell + the REAL Python core.
 * Skipped if the UI is not built.
 *
 * A page with a black block and a blue block is opened. A box is dragged over the black block and
 * erased (paper fill); the blue ink is removed with the stain tool. The saved file is read back:
 * the black block is now paper-coloured, and the blue ink is gone.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-erase-e2e-'));
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

test('a dragged box erases the black block with paper, and the stain tool removes the blue ink', async () => {
  test.setTimeout(300_000);
  const source = path.join(workDir, 'erase-page.pdf');
  py('erase_corpus.py', source);
  const before = JSON.parse(py('erase_check.py', source)) as {
    blockMean: number;
    blueShare: number;
  };
  expect(before.blockMean).toBeLessThan(60);
  expect(before.blueShare).toBeGreaterThan(0.9);

  launched = await launchApp({ args: [source], env: { CHEF_CORE_CMD: realCoreCmd } });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Tẩy vùng');
  await page.getByText('Tẩy vùng và xóa vết màu…', { exact: true }).click();
  const dialog = page.locator('.dlg');
  await expect(dialog.locator('.dlg__title')).toHaveText('Tẩy vùng và xóa vết màu');

  // Erase: preview the page, drag a box over the black block (fractions 0.2-0.8 by 0.15-0.35).
  await dialog.locator('#erase-page').fill('1');
  await dialog.getByRole('button', { name: 'Xem trước trang', exact: true }).click();
  const frame = dialog.locator('.erase-preview__frame');
  await expect(frame.locator('img')).toBeVisible({ timeout: 60_000 });
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height * 0.35, { steps: 5 });
  await page.mouse.up();
  await expect(dialog.locator('.erase-preview__rect')).toHaveCount(1);
  await dialog
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Tẩy vùng', exact: true })
    .click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });

  // Stain: remove blue pen ink from the page, then save both changes.
  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Tẩy vùng');
  await page.getByText('Tẩy vùng và xóa vết màu…', { exact: true }).click();
  const stainDialog = page.locator('.dlg');
  await stainDialog.getByRole('radio', { name: 'Xóa vết màu' }).check();
  await stainDialog.getByRole('radio', { name: 'Bút xanh' }).check();
  await stainDialog
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Xóa vết màu', exact: true })
    .click();
  await expect(stainDialog).toHaveCount(0, { timeout: 60_000 });

  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
  const after = JSON.parse(py('erase_check.py', source)) as {
    blockMean: number;
    blueShare: number;
  };
  expect(after.blockMean).toBeGreaterThan(200);
  expect(after.blueShare).toBeLessThan(0.05);
});
