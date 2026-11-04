/** Finger removal UI (T8.10) + Electron shell + the REAL Python core. Skipped if the UI is not built.
 *
 * A page with a finger on its edge is opened. The dialog proposes the finger regions, the proposal
 * is applied, the document is saved, and the saved file is measured from its pixels: the skin
 * pixels on the page border drop to a small share of what they were.
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

function skinBorder(file: string): number {
  const report = JSON.parse(py('demo_v08_check.py', file)) as { rows: { skinBorder: number }[] };
  return report.rows[0]!.skinBorder;
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-finger-e2e-'));
  py('demo_v08_photos.py', workDir);
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

test('the proposed finger regions are removed from the page edge and the saved file is clean', async () => {
  test.setTimeout(300_000);
  const source = path.join(workDir, 'finger-page-copy.pdf');
  fs.copyFileSync(path.join(workDir, 'finger-page.pdf'), source);
  const before = skinBorder(source);
  expect(before).toBeGreaterThan(50);

  launched = await launchApp({ args: [source], env: { CHEF_CORE_CMD: realCoreCmd } });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Xóa ngón tay');
  await page.getByText('Xóa ngón tay…', { exact: true }).click();
  const dialog = page.locator('.dlg');
  await expect(dialog.locator('.dlg__title')).toHaveText('Xóa ngón tay');

  await dialog.locator('#finger-page').fill('1');
  await dialog.getByRole('button', { name: 'Đề xuất vùng ngón tay', exact: true }).click();
  await expect(dialog.locator('.finger-editor__mask')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.locator('.finger-editor')).toContainText('Vùng sẽ xóa:');

  await dialog.locator('.dlg__footer').getByRole('button', { name: 'Xóa ngón tay' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.doctab__dirty')).toHaveCount(1);

  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
  const after = skinBorder(source);
  expect(after).toBeLessThan(before * 0.2);
});
