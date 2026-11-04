/** Bug B1 along the in-session path: a signed document, "Tạo bản sao để sửa" (editableCopy), then
 * convert the copy to a scan, save, close, and open the copy again.
 *
 * The signed input is made here from a text PDF with a throwaway certificate (b1_signed_corpus.py).
 * The original signed file must stay byte for byte. Set CHEF_E2E_EXE to run the same steps on the
 * packaged exe with its bundled core. The copy's state is read from disk right after the save and
 * again after reopening.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const packaged = !!process.env.CHEF_E2E_EXE;
const coreDir = path.join(repoRoot, 'core');
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;

let workDir = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt && !packaged, 'UI not built (run pnpm --filter @chef/ui build)');

function py(script: string, args: string[]): string {
  return execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(fixturesDir, script), ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 300_000 },
  ).trim();
}

function pdfState(file: string): {
  pages: number;
  textChars: number;
  acroform: boolean;
  sigFields: number;
  annots: number;
} {
  return JSON.parse(py('pdf_state.py', [file]));
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-b1-session-'));
  py('textedit_corpus.py', [workDir]);
  py('b1_signed_corpus.py', [path.join(workDir, 'contract.pdf'), workDir]);
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

test('signed original, editable copy, scan, save, reopen: the copy has no text left', async () => {
  test.setTimeout(600_000);
  const signed = path.join(workDir, 'signed.pdf');
  const copyPath = path.join(workDir, 'signed_ban-sao.pdf');
  const signedSha = sha256(signed);
  console.log('B1s signed input', JSON.stringify(pdfState(signed)));

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-b1-session-ud-'));
  launched = await launchUnderTest({
    args: [signed],
    env: { CHEF_CORE_CMD: realCoreCmd },
    userDataDir: userData,
  });
  const page = launched.page;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  await expect(page.getByText('Tài liệu đã được ký số', { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });

  // The save dialog is replaced by a stub that answers with the copy path.
  await launched.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as never;
  }, copyPath);
  await page.locator('text=Tạo bản sao để sửa').first().click();
  await expect(page.locator('.doctab', { hasText: 'ban-sao' }).first()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  console.log('B1s copy on disk', JSON.stringify(pdfState(copyPath)));

  await page.click('.ftab >> text=Xuất');
  await page.click('.toolbar__btn:has-text("Bản scan")');
  const dialog = page.locator('.dlg');
  await dialog.locator('.dlg__footer >> text=Chuyển đổi').click();
  await expect(page.locator('.dlg__title')).toHaveText('Đã chuyển thành bản scan', {
    timeout: 300_000,
  });
  await dialog.locator('.dlg__footer >> text=Đóng').click();
  await expect(page.locator('.dlg')).toHaveCount(0, { timeout: 30_000 });
  await page.keyboard.press('Control+s');
  await expect(page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 120_000 });
  const afterSave = pdfState(copyPath);
  console.log('B1s copy right after save', JSON.stringify(afterSave));
  await launched.app.close();
  launched = null;

  launched = await launchUnderTest({
    args: [copyPath],
    env: { CHEF_CORE_CMD: realCoreCmd },
    userDataDir: userData,
  });
  await launched.page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  const reopened = pdfState(copyPath);
  console.log('B1s copy after reopen', JSON.stringify(reopened));

  expect(sha256(signed)).toBe(signedSha);
  expect(reopened.textChars).toBe(0);
});
