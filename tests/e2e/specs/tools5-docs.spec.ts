/**
 * Document tools of v0.5 (M7-M10) end to end: built UI + Electron shell + the REAL Python core.
 * Properties, attachments, image and text extraction, and optimizing for the web, all from the
 * "Thuộc tính & tiện ích" dialog. Requires `pnpm --filter @chef/ui build` and `uv`.
 * Native file and folder pickers are replaced by stubs that answer with paths in the temp corpus.
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
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-tools5-docs-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'tools5_docs_corpus.py'), corpus],
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

/** Opens a corpus file and shows the "Thuộc tính & tiện ích" dialog on the given section. */
const openTools = async (file: string, section: string): Promise<Launched> => {
  launched = await launchApp({
    args: [path.join(corpus, file)],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Xuất');
  await l.page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await l.page.getByRole('menuitem', { name: /Thuộc tính & tiện ích/ }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Thuộc tính & tiện ích');
  await l.page.getByRole('radio', { name: section, exact: true }).click();
  return l;
};

const waitJobs = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });

const closeDialog = async (l: Launched) => {
  await l.page.locator('.dlg__close').click();
  // Shortcuts are ignored while a dialog is open.
  await expect(l.page.locator('.dlg__title')).toHaveCount(0);
};

const saveDoc = async (l: Launched) => {
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });
};

const pickFolderAs = (l: Launched, dir: string) =>
  l.app.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
  }, dir);

test('properties: the title typed in the dialog is in the saved file', async () => {
  const l = await openTools('docs_meta.pdf', 'Thuộc tính');
  // The field labels of this dialog are not tied to their inputs (no htmlFor): find the field.
  await l.page.locator('.field', { hasText: 'Tiêu đề' }).locator('input').fill('Hợp đồng thử');
  await l.page.getByRole('button', { name: 'Lưu thuộc tính', exact: true }).click();
  await waitJobs(l);
  await closeDialog(l);
  await saveDoc(l);
  expect(check(path.join(corpus, 'docs_meta.pdf'), 'title')).toEqual({ title: 'Hợp đồng thử' });
});

test('attachments: list, extract, add and remove an embedded file', async () => {
  const l = await openTools('docs_attach.pdf', 'Đính kèm');
  const list = l.page.getByRole('list', { name: 'Danh sách file đính kèm' });
  await expect(list).toContainText('note.txt', { timeout: 30_000 });

  const outDir = path.join(corpus, 'attach_out');
  await pickFolderAs(l, outDir);
  await l.page.getByRole('button', { name: 'Lưu ra thư mục…' }).click();
  await expect
    .poll(() => fs.existsSync(path.join(outDir, 'note.txt')), { timeout: 30_000 })
    .toBe(true);
  expect(fs.readFileSync(path.join(outDir, 'note.txt'), 'utf8')).toBe('attached note');

  const extra = path.join(corpus, 'extra.txt');
  await l.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, extra);
  await l.page.getByRole('button', { name: 'Thêm file…' }).click();
  await expect(list).toContainText('extra.txt', { timeout: 30_000 });

  await list.getByRole('checkbox', { name: /note\.txt/ }).check();
  await l.page.getByRole('button', { name: 'Xóa đã chọn', exact: true }).click();
  await l.page
    .getByRole('dialog', { name: 'Xóa file đính kèm?' })
    .getByRole('button', { name: 'Xóa đã chọn' })
    .click();
  await expect(list).not.toContainText('note.txt', { timeout: 30_000 });
  await waitJobs(l);
  await closeDialog(l);
  await saveDoc(l);
  expect(check(path.join(corpus, 'docs_attach.pdf'), 'attachments')).toEqual({
    names: ['extra.txt'],
  });
});

test('extract: the embedded image and the page text are written out', async () => {
  const l = await openTools('docs_extract.pdf', 'Trích ảnh');
  const imageDir = path.join(corpus, 'images_out');
  await pickFolderAs(l, imageDir);
  await l.page.getByRole('button', { name: 'Chọn thư mục…' }).click();
  await l.page.getByRole('button', { name: 'Trích ảnh', exact: true }).last().click();
  await expect
    .poll(() => (fs.existsSync(imageDir) ? fs.readdirSync(imageDir).length : 0), {
      timeout: 30_000,
    })
    .toBe(1);
  expect(fs.statSync(path.join(imageDir, fs.readdirSync(imageDir)[0]!)).size).toBeGreaterThan(0);

  const textFile = path.join(corpus, 'extracted.txt');
  await l.page.getByRole('radio', { name: 'Trích chữ', exact: true }).click();
  await l.app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  }, textFile);
  await l.page.getByRole('button', { name: /Chọn nơi lưu file \.txt/ }).click();
  await l.page.getByRole('button', { name: 'Trích chữ', exact: true }).last().click();
  await expect.poll(() => fs.existsSync(textFile), { timeout: 30_000 }).toBe(true);
  expect(fs.readFileSync(textFile, 'utf8')).toContain('Hello Chef PDF');
});

test('optimize for the web: the saved file is linearized and keeps its page', async () => {
  const l = await openTools('docs_web.pdf', 'Tối ưu web');
  const file = path.join(corpus, 'docs_web.pdf');
  expect(check(file, 'linear')).toEqual({ linearized: false, pages: 1 });
  await l.page.getByRole('button', { name: 'Tối ưu file', exact: true }).click();
  await expect(l.page.getByRole('status').filter({ hasText: 'Dung lượng' })).toBeVisible({
    timeout: 60_000,
  });
  expect(check(file, 'linear')).toEqual({ linearized: true, pages: 1 });
});
