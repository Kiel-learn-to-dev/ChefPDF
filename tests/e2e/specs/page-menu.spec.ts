/**
 * Context menu of the selected pages in the page grid (C13, C14) end to end: built UI + Electron
 * shell + the REAL Python core. Create a PDF from the selected pages (opens in a new tab, the
 * source file stays as it was), the stamp dialog preset to the selected pages, and compress on
 * the new tab. The native save dialog is replaced by a stub.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');

let corpus = '';
let source = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs tools5_check.py with the core's Python environment and returns its JSON output. */
function check(file: string, mode: string): Record<string, unknown> {
  const script = path.join(fixturesDir, 'tools5_check.py');
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', script, file, mode],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-page-menu-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(fixturesDir, 'tools5_pages_corpus.py'),
      corpus,
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  source = path.join(corpus, 'menu_pages.pdf');
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

/** Opens the 4-page file on the Trang tab, selects pages 2 and 4 (Ctrl+click). */
async function openWithPages2And4(): Promise<Launched> {
  launched = await launchApp({ args: [source], env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Trang');
  await l.page.locator('.page-card[data-index="1"]').click();
  await l.page.locator('.page-card[data-index="3"]').click({ modifiers: ['Control'] });
  await expect(l.page.locator('.page-card.is-selected')).toHaveCount(2);
  return l;
}

test('create a PDF from the selected pages: a new tab with those pages, the source unchanged', async () => {
  const before = sha(source);
  const l = await openWithPages2And4();
  const out = path.join(corpus, 'selected_2_4.pdf');
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as never;
  }, out);

  await l.page.locator('.page-card[data-index="3"]').click({ button: 'right' });
  await l.page.getByRole('menuitem', { name: 'Tạo PDF từ 2 trang đã chọn' }).click();

  // The new file opens in a tab of its own and becomes the active one.
  await expect(l.page.locator('.doctab:not(.doctab--home)')).toHaveCount(2, { timeout: 60_000 });
  await expect(l.page.locator('.doctab.is-active')).toContainText('selected_2_4');
  await l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });

  expect(check(out, 'pagetexts')).toEqual({ texts: ['M2', 'M4'] });
  // The source is only read: same bytes, still 4 pages.
  expect(sha(source)).toBe(before);
  expect(check(source, 'pagetexts')).toEqual({ texts: ['M1', 'M2', 'M3', 'M4'] });
});

test('stamp the selected pages: the stamp dialog opens with the range of the selection', async () => {
  const l = await openWithPages2And4();
  // Pages 1 and 3 instead, so the range text is not the same as the previous test.
  await l.page.locator('.page-card[data-index="0"]').click();
  await l.page.locator('.page-card[data-index="2"]').click({ modifiers: ['Control'] });
  await l.page.locator('.page-card[data-index="2"]').click({ button: 'right' });
  await l.page.getByRole('menuitem', { name: 'Đóng dấu các trang đã chọn…' }).click();

  await expect(l.page.locator('.dlg__title')).toHaveText('Con dấu');
  await expect(l.page.locator('#stamp-choice')).toContainText('Khoảng trang');
  await expect(l.page.locator('#stamp-range')).toHaveValue('1,3');
  // The source file is not touched until the stamp runs.
  expect(check(source, 'pagetexts')).toEqual({ texts: ['M1', 'M2', 'M3', 'M4'] });
});

test('compress the selected pages: the new tab opens with the compress dialog', async () => {
  const l = await openWithPages2And4();
  const out = path.join(corpus, 'selected_compress.pdf');
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as never;
  }, out);

  await l.page.locator('.page-card[data-index="3"]').click({ button: 'right' });
  await l.page.getByRole('menuitem', { name: 'Nén các trang đã chọn…' }).click();

  await expect(l.page.locator('.dlg__title')).toHaveText('Nén PDF');
  await expect(l.page.locator('.doctab:not(.doctab--home)')).toHaveCount(2);
  await expect(l.page.locator('.doctab.is-active')).toContainText('selected_compress');
  expect(check(out, 'pagetexts')).toEqual({ texts: ['M2', 'M4'] });
});
