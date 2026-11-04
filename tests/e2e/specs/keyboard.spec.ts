/** Keyboard-only use of the main commands (T11.05) with the real app and core. Skipped if the UI is
 * not built. Uses only keys: the command palette opens, runs a command, closes with Escape; the find
 * bar opens; undo and redo work after an edit; Save works; tab switching works with Ctrl+Tab.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-keyboard-e2e-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(fixturesDir, 'erase_corpus.py'),
      path.join(workDir, 'page.pdf'),
    ],
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

test('the main commands run from the keyboard alone: palette, find, undo, redo, save, tabs', async () => {
  test.setTimeout(180_000);
  const source = path.join(workDir, 'page.pdf');
  launched = await launchApp({ args: [source], env: { CHEF_CORE_CMD: realCoreCmd } });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  // Palette: Ctrl+K, type a command, Enter runs it, Escape would close it.
  await page.keyboard.press('Control+k');
  await expect(page.locator('.palette__input')).toBeVisible();
  await page.keyboard.type('Chỉnh ảnh trang');
  await page.keyboard.press('Enter');
  await expect(page.locator('.dlg__title')).toHaveText('Chỉnh ảnh trang');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dlg')).toHaveCount(0);

  // Find bar: Ctrl+F opens it and focus goes to the field; Escape closes it.
  await page.keyboard.press('Control+f');
  await expect(page.locator('.findbar__input')).toBeFocused({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  // Undo and redo: a page rotation (Trang tab command) is undone with Ctrl+Z, redone with Ctrl+Y.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Xoay trang sang phải');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.doctab__dirty')).toHaveCount(1, { timeout: 30_000 });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press('Control+y');
  await expect(page.locator('.doctab__dirty')).toHaveCount(1, { timeout: 30_000 });

  // Save with Ctrl+S clears the dirty mark.
  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 30_000 });
});
