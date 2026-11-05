/**
 * Demo v1.1 (PLAN_V1_1 mục 5.7), built UI + Electron shell + the REAL Python core, on a PDF with text:
 * 1. Chỉnh sửa is on: the status bar shows the mode and "Có chữ".
 * 2. A click selects the paragraph; the format bar has its controls.
 * 3. Bold, centre and size +1 in a row; Ctrl+Z undoes them one at a time back to the start.
 * 4. The paragraph text changes to a Vietnamese sentence with diacritics; saved, the file has it.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';
import { clickEdit, selectLine } from '../fixtures/textedit';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const OLD_LINE = 'trong vòng 30 ngày';
const NEW_SENTENCE = 'Thanh toán trước ngày 15 tháng 12 năm 2026 tại văn phòng của bên A.';

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs the check script of the corpus on a saved file and returns its JSON output. */
function check(file: string, args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(corpus, 'textedit_check.py'),
      file,
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-demo-v11-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'textedit_corpus.py'), corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'textedit_check.py'),
    path.join(corpus, 'textedit_check.py'),
  );
});

test.afterEach(async () => {
  const l = launched;
  launched = null;
  if (!l) return;
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
  fs.rmSync(corpus, { recursive: true, force: true });
});

test('demo v1.1: edit mode, one paragraph formatted and re-typed, saved text has it', async () => {
  test.setTimeout(240_000);
  const file = path.join(corpus, `demo-v11-${Date.now()}.pdf`);
  fs.copyFileSync(path.join(corpus, 'contract.pdf'), file);
  launched = await launchUnderTest({ args: [file], env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  // 1. Edit mode is on and the status bar says so, with the text layer.
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  await expect(l.page.locator('.status')).toContainText('Chế độ Chỉnh sửa');
  await expect(l.page.locator('.status')).toContainText('Có chữ');

  // 2. A click selects the paragraph; the bar has its controls on.
  await selectLine(l.page, OLD_LINE);
  const bar = l.page.getByRole('toolbar', { name: 'Định dạng chữ' });
  const bold = bar.getByRole('button', { name: 'In đậm' });
  const size = bar.getByLabel('Cỡ chữ (pt)');
  await expect(bold).toBeEnabled({ timeout: 30_000 });
  const start = Number(await size.inputValue());
  const alignStart = (await bar.getByRole('combobox', { name: 'Căn lề' }).textContent())?.trim();

  // 3. Bold, centre, size +1 in a row; each Ctrl+Z undoes one of them.
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await bar.getByRole('combobox', { name: 'Căn lề' }).click();
  await l.page.getByRole('option', { name: 'Giữa' }).click();
  await expect(bar.getByRole('combobox', { name: 'Căn lề' })).toHaveText(/Giữa/, {
    timeout: 30_000,
  });
  await bar.getByRole('button', { name: 'Tăng cỡ chữ' }).click();
  await expect(size).toHaveValue(String(start + 1), { timeout: 30_000 });
  await l.page.keyboard.press('Control+z');
  await expect(size).toHaveValue(String(start), { timeout: 30_000 });
  await l.page.keyboard.press('Control+z');
  await expect(bar.getByRole('combobox', { name: 'Căn lề' })).toHaveText(alignStart ?? '', {
    timeout: 30_000,
  });
  await l.page.keyboard.press('Control+z');
  await expect(bold).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });

  // 4. Re-type the paragraph in place (D62): a click opens it, Ctrl+A, the new text, a click outside.
  await selectLine(l.page, OLD_LINE);
  await clickEdit(l.page);
  await l.page.keyboard.press('Control+a');
  await l.page.keyboard.type(`${NEW_SENTENCE} Mọi khoản phí do bên B chịu.`);
  const pageBox = await l.page.locator('.pdfViewer .page canvas').first().boundingBox();
  if (!pageBox) throw new Error('page has no box');
  await l.page.mouse.click(pageBox.x + 4, pageBox.y + 4);
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 30_000 });
  await l.page.keyboard.press('Control+s');
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 120_000 });
  const saved = (check(file, ['text', '0']) as { text: string }).text.replace(/\s+/g, ' ');
  expect(saved).toContain(NEW_SENTENCE);
  expect(saved).not.toContain(OLD_LINE);
});
