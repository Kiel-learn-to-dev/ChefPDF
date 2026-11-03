/**
 * Page tools of v0.5 (C6, C7, C9) end to end: built UI + Electron shell + the REAL Python core.
 * Replace pages from another file, crop margins, change the page size, split pages into pieces.
 * Requires `pnpm --filter @chef/ui build` and `uv`. The native file picker is replaced by a stub.
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

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs tools5_check.py with the core's Python environment and returns its JSON output. */
function check(file: string, mode: string): Record<string, unknown> {
  const script = path.join(fixturesDir, 'tools5_check.py');
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', script, file, mode],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-tools5-pages-'));
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

/** Opens a corpus file, then the page tool of the Trang tab overflow menu with that title. */
const openTool = async (file: string, menuItem: RegExp, title: string): Promise<Launched> => {
  launched = await launchApp({
    args: [path.join(corpus, file)],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Trang');
  await l.page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await l.page.getByRole('menuitem', { name: menuItem }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText(title);
  return l;
};

const finishAndSave = async (l: Launched) => {
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });
  await l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });
};

test('replace pages: page 2 of a 3-page file is replaced by the page of another file', async () => {
  const l = await openTool('rep_target.pdf', /Thay trang/, 'Thay trang');
  const source = path.join(corpus, 'rep_source.pdf');
  await l.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, source);
  await l.page.fill('#replace-target', '2');
  await l.page.getByRole('button', { name: 'Chọn…' }).click();
  await expect(l.page.getByRole('textbox', { name: 'File nguồn', exact: true })).toHaveValue(
    'rep_source.pdf',
  );
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Thay trang', exact: true })
    .click();
  await finishAndSave(l);
  expect(check(path.join(corpus, 'rep_target.pdf'), 'pagetexts')).toEqual({
    texts: ['T1', 'S1', 'T3'],
  });
  // The source file is only read.
  expect(check(source, 'pagetexts')).toEqual({ texts: ['S1'] });
});

test('crop margins: 10 mm on every side shrinks the visible page, the content stays', async () => {
  const l = await openTool('crop.pdf', /Cắt lề/, 'Cắt lề / đổi khổ');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    await l.page.fill(`#crop-${side}`, '10');
  }
  await l.page.locator('.dlg__footer').getByRole('button', { name: 'Cắt lề', exact: true }).click();
  await finishAndSave(l);
  const file = path.join(corpus, 'crop.pdf');
  // Letter 612 x 792 pt minus 2 x 10 mm (28.35 pt) per axis.
  expect(check(file, 'sizes')).toEqual({ sizes: [[555, 735]] });
  expect(check(file, 'pagetexts')).toEqual({ texts: ['C1'] });
});

test('change the page size: a Letter page becomes A4', async () => {
  const l = await openTool('resize.pdf', /Cắt lề/, 'Cắt lề / đổi khổ');
  await l.page.locator('.dlg [role="combobox"]').first().click();
  await l.page.getByRole('option', { name: 'Đổi khổ' }).click();
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Đổi khổ', exact: true })
    .click();
  await finishAndSave(l);
  const file = path.join(corpus, 'resize.pdf');
  expect(check(file, 'sizes')).toEqual({ sizes: [[595, 842]] });
  expect(check(file, 'pagetexts')).toEqual({ texts: ['R1'] });
});

test('split pages: 2 Letter pages cut in two columns make 4 half-width pages', async () => {
  const l = await openTool('split.pdf', /Chia đôi trang/, 'Chia đôi trang');
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Chia trang', exact: true })
    .click();
  await finishAndSave(l);
  expect(check(path.join(corpus, 'split.pdf'), 'sizes')).toEqual({
    sizes: [
      [306, 792],
      [306, 792],
      [306, 792],
      [306, 792],
    ],
  });
});
