/** Curved-page UI + Electron shell + the REAL Python core. Skipped if the UI is not built. */
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
let sourcePdf = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-dewarp-e2e-'));
  sourcePdf = path.join(workDir, 'curved-book.pdf');
  execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', path.join(fixturesDir, 'dewarp_corpus.py'), sourcePdf],
    { cwd: repoRoot, timeout: 120_000 },
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

function report(file: string): { pages: number; rows: { hasImage: boolean; span: number }[] } {
  const output = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', path.join(fixturesDir, 'dewarp_check.py'), file],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  );
  return JSON.parse(output) as { pages: number; rows: { hasImage: boolean; span: number }[] };
}

async function openDewarp(): Promise<Launched> {
  launched = await launchApp({ args: [sourcePdf], env: { CHEF_CORE_CMD: realCoreCmd } });
  await launched.page.setViewportSize({ width: 1280, height: 900 });
  await launched.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await launched.page.keyboard.press('Control+k');
  await launched.page.locator('.palette__input').fill('Làm phẳng trang cong');
  await launched.page.getByText('Làm phẳng trang cong…', { exact: true }).click();
  await expect(launched.page.locator('.dlg__title')).toHaveText('Làm phẳng trang cong');
  return launched;
}

test('previews without changing the PDF, applies the curve correction, and leaves low-confidence pages untouched', async () => {
  const l = await openDewarp();
  const page = l.page;
  const dialog = page.locator('.dlg');

  // Real-core preview produces the before/after images and confidence without making the session dirty.
  await page.locator('#dewarp-pages').fill('1');
  await dialog.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(dialog.locator('.dewarp-preview__images img')).toHaveCount(2, { timeout: 60_000 });
  await expect(dialog.locator('.dewarp-preview__meta')).toContainText('Độ tin cậy:');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0);
  await expect(
    dialog.locator('.dlg__footer').getByRole('button', { name: 'Áp dụng làm phẳng' }),
  ).toBeEnabled();

  // Applying only page 1 creates a revision. Save it, then independently inspect the embedded image.
  await dialog.locator('.dlg__footer').getByRole('button', { name: 'Áp dụng làm phẳng' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.doctab__dirty')).toHaveCount(1);
  const original = report(sourcePdf);
  expect(original.pages).toBe(2);
  expect(original.rows[0]?.hasImage).toBe(true);
  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
  const flattened = report(sourcePdf);
  expect(flattened.pages).toBe(2);
  expect(flattened.rows[0]!.span).toBeLessThan(original.rows[0]!.span * 0.6);

  // Page 2 has an image but no text-line evidence: the preview warns, and apply leaves it clean.
  await page.keyboard.press('Control+k');
  await page.locator('.palette__input').fill('Làm phẳng trang cong');
  await page.getByText('Làm phẳng trang cong…', { exact: true }).click();
  const lowDialog = page.locator('.dlg');
  await page.locator('#dewarp-pages').fill('2');
  await lowDialog.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(lowDialog.locator('.dewarp-preview__meta')).toContainText('Độ tin cậy: 0%');
  await expect(lowDialog.locator('.task__warnings')).toContainText('2 cần xem lại');
  await lowDialog
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Áp dụng làm phẳng' })
    .click();
  await expect(lowDialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.doctab__dirty')).toHaveCount(0);
});
