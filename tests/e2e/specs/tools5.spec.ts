/**
 * Tools 5 end to end: built UI + Electron shell + the REAL Python core.
 * Password (security), inspect and remove hidden data, compression, images to PDF, blank-page
 * review, and colour conversion. Requires `pnpm --filter @chef/ui build` and `uv`.
 * Skipped automatically when the UI has not been built.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  events,
  launchApp,
  recordEvents,
  removeTempDirs,
  repoRoot,
  type Launched,
} from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'tools5');
const PASSWORD = 'chefpass1';

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs a fixture script with the core's Python environment and returns its JSON output. */
function py(script: string, args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(corpus, script), ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-tools5-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'tools5_corpus.py'), corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(path.join(fixturesDir, 'tools5_check.py'), path.join(corpus, 'tools5_check.py'));
  fs.mkdirSync(shotsDir, { recursive: true });
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

const open = async (file: string): Promise<Launched> => {
  launched = await launchApp({
    args: [path.join(corpus, file)],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
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

test('password: set it in the security dialog, save, and reopening asks for it', async () => {
  const l = await open('secure.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Ký & Bảo mật');
  await l.page.click('.toolbar__btn:has-text("Mật khẩu")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Mật khẩu & quyền');
  await l.page.fill('#sec-user', PASSWORD);
  await l.page.fill('#sec-user-confirm', PASSWORD);
  await l.page.click('.dlg__footer >> text=Đặt mật khẩu');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  // Close this run, then open the saved file again: the core asks for the password.
  await l.app.close();
  launched = null;
  const again = await open('secure.pdf');
  const input = again.page.locator('input[type="password"]');
  await input.waitFor({ timeout: 30_000 });
  await input.fill('wrong-password');
  await input.press('Enter');
  await expect(again.page.locator('input[type="password"]')).toBeVisible();
  await input.fill(PASSWORD);
  await input.press('Enter');
  await waitViewer(again);
  await again.page.screenshot({ path: path.join(shotsDir, 'password.png') });
});

test('inspect: a metadata finding is removed and the rescan finds nothing', async () => {
  const l = await open('meta.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Ký & Bảo mật');
  await l.page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await l.page.getByRole('menuitem', { name: /Soi file/ }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Soi file & dọn dữ liệu ẩn');
  await expect(l.page.locator('.dlg__body')).toContainText('Metadata');
  await l.page.screenshot({ path: path.join(shotsDir, 'inspect.png') });

  await l.page.getByRole('button', { name: /Dọn các mục đã chọn/ }).click();
  await waitJobs(l);
  await l.page.getByRole('button', { name: 'Soi lại', exact: true }).click();
  await expect(l.page.locator('.dlg__body')).toContainText('Không tìm thấy dữ liệu ẩn nào.', {
    timeout: 30_000,
  });

  // The cleaned document is saved, so closing the app does not raise the unsaved-changes prompt.
  await l.page.keyboard.press('Escape');
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(py('tools5_check.py', [path.join(corpus, 'meta.pdf'), 'meta'])).toEqual({ author: null });
});

test('compression with the screen preset: the saved file is smaller and still opens', async () => {
  const l = await open('image_heavy.pdf');
  await waitViewer(l);
  const src = path.join(corpus, 'image_heavy.pdf');
  const before = fs.statSync(src).size;

  await l.page.click('.ftab >> text=Xuất');
  await l.page.click('.toolbar__btn:has-text("Nén PDF")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Nén PDF');
  await l.page.locator('.dlg [role="combobox"]').first().click();
  await l.page.getByRole('option', { name: 'Màn hình (nhẹ nhất)' }).click();
  await l.page.locator('.dlg__footer').getByRole('button', { name: 'Nén', exact: true }).click();
  await expect(l.page.locator('.compress__result')).toBeVisible({ timeout: 90_000 });
  await l.page.keyboard.press('Escape');
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const after = fs.statSync(src).size;
  expect(after).toBeLessThan(before);
  expect(py('tools5_check.py', [src, 'info'])).toEqual({ pages: 1, opens: true });
});

test('images to PDF: two generated PNG files make a two-page PDF', async () => {
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await recordEvents(l.page);
  const out = path.join(corpus, 'from_images.pdf');
  const images = [path.join(corpus, 'a.png'), path.join(corpus, 'b.png')];
  const { jobId } = await l.page.evaluate(
    ({ images: imgs, outputPath }) =>
      window.chef.rpc('ops.run', {
        opId: 'convert.imagesToPdf',
        params: { images: imgs, outputPath, pageSize: 'a4', marginMm: 10 },
      }),
    { images, outputPath: out },
  );
  await l.page.waitForFunction(
    (id) =>
      (
        (window.__chefEvents ?? []) as {
          type: string;
          name?: string;
          payload?: { jobId?: string };
        }[]
      ).some((e) => e.type === 'rpc' && e.name === 'job.finished' && e.payload?.jobId === id),
    jobId,
    { timeout: 60_000 },
  );
  const finished = (await events<{ name?: string }>(l.page)).some((e) => e.name === 'job.finished');
  expect(finished).toBe(true);
  expect(py('tools5_check.py', [out, 'info'])).toEqual({ pages: 2, opens: true });
});

test('blank pages: the review lists the blank page and deleting it leaves two pages', async () => {
  const l = await open('blank_mixed.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Trang');
  await expect(l.page.locator('.page-card')).toHaveCount(3, { timeout: 30_000 });
  await l.page.getByRole('button', { name: 'Thêm', exact: true }).click();
  await l.page.getByRole('menuitem', { name: /Xóa trang trắng/ }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Xóa trang trắng');
  await expect(l.page.getByRole('checkbox', { name: /Trang 2/ })).toBeChecked({ timeout: 60_000 });
  await expect(l.page.getByRole('checkbox', { name: /Trang 1/ })).not.toBeChecked();
  await l.page.screenshot({ path: path.join(shotsDir, 'blank-review.png') });

  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Xóa 1 trang đã chọn', exact: true })
    .click();
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });
  await waitJobs(l);
  await expect(l.page.locator('.page-card')).toHaveCount(2, { timeout: 30_000 });

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(py('tools5_check.py', [path.join(corpus, 'blank_mixed.pdf'), 'info'])).toEqual({
    pages: 2,
    opens: true,
  });
});

test('colour conversion to greyscale: the saved page has no colour left', async () => {
  const l = await open('colour.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Xuất');
  await l.page.getByRole('button', { name: 'Chuyển màu', exact: true }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Chuyển màu');
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: 'Chuyển màu', exact: true })
    .click();
  await expect(l.page.locator('.pt-result')).toContainText('Đã đổi', { timeout: 60_000 });
  await l.page.keyboard.press('Escape');
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const file = path.join(corpus, 'colour.pdf');
  const gray = py('tools5_check.py', [file, 'gray', '1']);
  expect(gray.maxChannelSpread).toBeLessThanOrEqual(2);
});
