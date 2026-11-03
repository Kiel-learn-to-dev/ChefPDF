/**
 * PDF to images (M2), repair of a damaged file (M11) and removing a password (J2) end to end:
 * built UI + Electron shell + the REAL Python core. Requires `pnpm --filter @chef/ui build` and
 * `uv`. Native file and folder pickers are replaced by stubs that answer with temp-corpus paths.
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
const PASSWORD = 'chefpass1';

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
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-tools5-convert-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(fixturesDir, 'tools5_convert_corpus.py'),
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

const launch = async (args: string[]): Promise<Launched> => {
  launched = await launchApp({ args, env: { CHEF_CORE_CMD: realCoreCmd } });
  await launched.page.setViewportSize({ width: 1280, height: 800 });
  return launched;
};

const answerOpenDialog = (l: Launched, file: string) =>
  l.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, file);

test('PDF to images: two pages make two PNG files at the chosen resolution', async () => {
  const l = await launch([path.join(corpus, 'two_pages.pdf')]);
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Xuất');
  await l.page.click('.toolbar__btn:has-text("PDF → ảnh")');
  await expect(l.page.locator('.dlg__title')).toHaveText('PDF → ảnh');

  const outDir = path.join(corpus, 'images_out');
  await answerOpenDialog(l, outDir);
  await l.page.getByRole('button', { name: 'Chọn…' }).click();
  await expect(l.page.locator('#conv-dir')).toHaveValue(outDir);
  await l.page.fill('#conv-dpi', '72');
  // The dialog exports the page on screen unless told otherwise.
  await l.page.locator('#conv-pages-choice').click();
  await l.page.getByRole('option', { name: 'Tất cả (2 trang)' }).click();
  await l.page.locator('.dlg__footer').getByRole('button', { name: 'Chuyển', exact: true }).click();
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });

  const images = (
    check(outDir, 'images') as { images: { name: string; format: string; size: number[] }[] }
  ).images;
  // Named after the document, not after the working copy (rev-0000) the core reads.
  expect(images.map((image) => image.name)).toEqual(['two_pages_1.png', 'two_pages_2.png']);
  for (const image of images) {
    expect(image.format).toBe('PNG');
    // Letter at 72 dpi is 612 x 792 pixels.
    expect(image.size).toEqual([612, 792]);
  }
});

test('repair: a file without its cross-reference table gives a clean copy, the original stays', async () => {
  const damaged = path.join(corpus, 'broken.pdf');
  const before = fs.readFileSync(damaged);
  const repaired = path.join(corpus, 'broken_sua.pdf');
  // The damaged sample is really damaged: it cannot be read without recovery.
  expect(check(damaged, 'clean')).toEqual({ clean: false, pages: null });

  const l = await launch([]);
  await l.page.locator('.tile', { hasText: 'Sửa file PDF hỏng' }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Sửa file PDF hỏng');
  await answerOpenDialog(l, damaged);
  await l.page.getByRole('button', { name: 'Chọn file…' }).click();
  await l.page.getByRole('button', { name: 'Thử sửa file', exact: true }).click();

  // The repaired copy is opened in the viewer.
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  expect(check(repaired, 'clean')).toEqual({ clean: true, pages: 2 });
  expect(fs.readFileSync(damaged).equals(before)).toBe(true);
});

test('remove the password: the saved file opens without one', async () => {
  const file = path.join(corpus, 'locked.pdf');
  expect(check(file, 'encrypted')).toEqual({ encrypted: true, pages: null });

  const l = await launch([file]);
  const input = l.page.locator('input[type="password"]');
  await input.waitFor({ timeout: 30_000 });
  await input.fill(PASSWORD);
  await input.press('Enter');
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

  await l.page.click('.ftab >> text=Ký & Bảo mật');
  await l.page.click('.toolbar__btn:has-text("Mật khẩu")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Mật khẩu & quyền');
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Gỡ bảo vệ', exact: true })
    .click();
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });
  await l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });
  expect(check(file, 'encrypted')).toEqual({ encrypted: false, pages: 1 });
});
