/** Scan conversion, saved and reopened (bug report 2026-11-04): a text PDF converted to a scan must
 * have no text when the saved file is opened again. The steps are the user's: convert all pages,
 * save with Ctrl+S, close, open the same file again, and measure the file itself.
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

function textChars(file: string): { pages: number; textChars: number } {
  return JSON.parse(
    execFileSync(
      'uv',
      ['run', '--project', coreDir, 'python', '-I', path.join(fixturesDir, 'text_count.py'), file],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    ),
  ) as { pages: number; textChars: number };
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-scan-reopen-'));
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

test('all pages converted to a scan, saved, reopened: the file has no text left', async () => {
  test.setTimeout(300_000);
  const source = path.join(workDir, 'contract.pdf');
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(fixturesDir, 'textedit_corpus.py'),
      workDir,
    ],
    { cwd: repoRoot, timeout: 120_000 },
  );
  expect(textChars(source).textChars).toBeGreaterThan(0);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-scan-ud-'));
  launched = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: realCoreCmd },
    userDataDir: userData,
  });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await page.click('.ftab >> text=Xuất');
  await page.click('.toolbar__btn:has-text("Bản scan")');
  const dialog = page.locator('.dlg');
  await dialog.locator('.dlg__footer >> text=Chuyển đổi').click();
  await expect(page.locator('.dlg__title')).toHaveText('Đã chuyển thành bản scan', {
    timeout: 120_000,
  });
  await dialog.locator('.dlg__footer >> text=Đóng').click();
  await expect(page.locator('.dlg')).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 60_000 });
  await launched.app.close();
  launched = null;

  // Open the same file again in a new app run (same user data, so recent files work the same way).
  launched = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: realCoreCmd },
    userDataDir: userData,
  });
  await launched.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  expect(textChars(source).textChars).toBe(0);
});
