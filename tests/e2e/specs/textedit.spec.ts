/**
 * Text edit end to end (D8, D10, T7.02, T7.04): built UI + Electron shell + the REAL Python core.
 * (a) a line is replaced by a Vietnamese sentence with letters that the file's font subset does not
 *     contain (ư, ữ, ệ): the editor shows the substitution chip, the saved text has the new
 *     sentence, the old one is gone and the other lines are unchanged;
 * (b) find and replace of the company name over three pages: preview, then replace all; the saved
 *     text of every page has the new name.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');

/** New sentence: ư, ữ and ệ are not in the subset of the original file. */
const NEW_LINE = 'Thanh toán trước ngày 15 tháng 12 năm 2026';
const OLD_LINE = 'trong vòng 30 ngày';

let corpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs the check script on a saved file and returns its JSON output. */
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
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-textedit-'));
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
  // A dirty document makes the UI cancel the close to ask the user; never hang the suite on it.
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
  fs.rmSync(corpus, { recursive: true, force: true });
});

/** Opens a fresh copy of the contract (each test starts from the same document). */
const open = async (): Promise<Launched> => {
  current = path.join(corpus, `run-${Date.now()}.pdf`);
  fs.copyFileSync(path.join(corpus, 'contract.pdf'), current);
  launched = await launchApp({ args: [current], env: { CHEF_CORE_CMD: realCoreCmd } });
  await launched.page.setViewportSize({ width: 1280, height: 800 });
  return launched;
};

const waitViewer = (l: Launched) =>
  l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

const waitJobs = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });

const waitSaved = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });

test('text edit: the line gets a sentence the font does not contain; the saved text shows it', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();

  const box = l.page.locator(`[data-testid="tedit-box"][data-text*="${OLD_LINE}"]`);
  await box.waitFor({ timeout: 30_000 });
  const bounds = await box.boundingBox();
  if (!bounds) throw new Error('Text line has no bounding box');
  await l.page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  const input = l.page.locator('.tedit-editor__input');
  await expect(input).toBeVisible();
  await input.fill(NEW_LINE);
  // The original font cannot write ư, ữ, ệ: the chip says which font replaces it.
  await expect(l.page.locator('.tedit-chip--warn')).toBeVisible({ timeout: 15_000 });
  await input.press('Enter');
  await expect(l.page.locator('.tedit-editor')).toBeHidden({ timeout: 30_000 });
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (check(current, ['text', '0']) as { text: string }).text;
  expect(text).toContain(NEW_LINE);
  expect(text).not.toContain(OLD_LINE);
  // The other lines are unchanged.
  expect(text).toContain('Bên A là Công ty ABC');
  expect(text).toContain('Mọi khoản phí do bên B chịu');
  expect(text).toContain('Hợp đồng số 1');
});

test('find and replace: the company name changes on all three pages', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.keyboard.press('Control+h');
  const dlg = l.page.getByRole('dialog');
  await dlg.locator('#fr-find').fill('Công ty ABC');
  await dlg.locator('#fr-replace').fill('Công ty Hoa Sen');
  await dlg.getByRole('button', { name: 'Xem trước', exact: true }).click();
  // Page 1: one line; pages 2 and 3: two lines each.
  await expect(dlg.getByText('Tìm thấy 5 kết quả.')).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Thay tất cả', exact: true }).click();
  await expect(dlg).toBeHidden({ timeout: 30_000 });
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  for (const index of [0, 1, 2]) {
    const text = (check(current, ['text', String(index)]) as { text: string }).text;
    expect(text, `page ${index + 1}`).toContain('Hoa Sen');
    expect(text, `page ${index + 1}`).not.toContain('Công ty ABC');
  }
});

test('paragraph edit: replace Vietnamese text and save the result', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  const box = l.page.locator(`[data-testid="tedit-box"][data-text*="${OLD_LINE}"]`);
  await box.waitFor({ timeout: 30_000 });
  const bounds = await box.boundingBox();
  if (!bounds) throw new Error('Text line has no bounding box');
  await l.page.keyboard.down('Alt');
  await l.page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await l.page.keyboard.up('Alt');
  const dialog = l.page.getByRole('dialog', { name: 'Sửa đoạn' });
  const input = dialog.getByLabel('Nội dung đoạn');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(/Thanh toán trong vòng 30 ngày/);
  await input.fill(NEW_LINE);
  await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (check(current, ['text', '0']) as { text: string }).text;
  expect(text.replace(/\s+/g, ' ')).toContain(NEW_LINE);
  expect(text).not.toContain(OLD_LINE);
  expect(text).toContain('Bên A là Công ty ABC');
});

test('paragraph style: change font size without changing the text', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  const box = l.page.locator(`[data-testid="tedit-box"][data-text*="${OLD_LINE}"]`);
  await box.waitFor({ timeout: 30_000 });
  const bounds = await box.boundingBox();
  if (!bounds) throw new Error('Text line has no bounding box');
  await l.page.keyboard.down('Alt');
  await l.page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await l.page.keyboard.up('Alt');
  const dialog = l.page.getByRole('dialog', { name: 'Sửa đoạn' });
  await dialog.getByLabel('Cỡ chữ (pt)').fill('16');
  await dialog.getByRole('button', { name: 'Chỉ đổi kiểu' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (check(current, ['text', '0']) as { text: string }).text;
  expect(text.replace(/\s+/g, ' ')).toContain(OLD_LINE);
  expect((check(current, ['font-size', '0', 'Thanh toán']) as { size: number }).size).toBeCloseTo(
    16,
  );
});
