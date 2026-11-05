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
import { clickEdit, selectLine } from '../fixtures/textedit';

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

/** Clicks the page margin: outside the paragraph, so the session is written. */
async function clickOutside(l: Launched): Promise<void> {
  const page = l.page.locator('.pdfViewer .page canvas').first();
  const b = await page.boundingBox();
  if (!b) throw new Error('page has no box');
  await l.page.mouse.click(b.x + 4, b.y + 4);
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 30_000 });
}

test('text edit: a sentence is typed into the paragraph; the saved text shows it', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();

  // A click on the text opens the paragraph for typing; Ctrl+A selects its text, then the new text
  // replaces it. The original font cannot write ư, ữ, ệ: the chip says which font takes over.
  await selectLine(l.page, OLD_LINE);
  await clickEdit(l.page);
  await l.page.keyboard.press('Control+a');
  await l.page.keyboard.type(`${NEW_LINE}. Mọi khoản phí do bên B chịu.`);
  await expect(l.page.locator('.tedit-chip--warn').first()).toBeVisible({ timeout: 15_000 });
  await clickOutside(l);
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (check(current, ['text', '0']) as { text: string }).text;
  expect(text.replace(/\s+/g, ' ')).toContain(NEW_LINE);
  expect(text).not.toContain(OLD_LINE);
  // The other lines are unchanged.
  expect(text).toContain('Bên A là Công ty ABC');
  expect(text).toContain('Mọi khoản phí do bên B chịu');
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

test('paragraph edit: a paragraph is re-typed in place and the saved result has it', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  await selectLine(l.page, OLD_LINE);
  await clickEdit(l.page);
  await l.page.keyboard.press('Control+a');
  await l.page.keyboard.type(NEW_LINE);
  await clickOutside(l);
  await waitJobs(l);
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
  await selectLine(l.page, OLD_LINE);
  const size = l.page.getByRole('toolbar', { name: 'Định dạng chữ' }).getByLabel('Cỡ chữ (pt)');
  await size.fill('16');
  await size.press('Enter');
  await expect(size).toHaveValue('16', { timeout: 30_000 });
  await size.blur();
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (check(current, ['text', '0']) as { text: string }).text;
  expect(text.replace(/\s+/g, ' ')).toContain(OLD_LINE);
  expect((check(current, ['font-size', '0', 'Thanh toán']) as { size: number }).size).toBeCloseTo(
    16,
  );
});
