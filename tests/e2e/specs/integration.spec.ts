/**
 * Full-stack integration: built UI + Electron shell + the REAL Python core.
 * Requires `pnpm --filter @chef/ui build` and `uv` (core is launched with `uv run`).
 * Skipped automatically when the UI has not been built.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const realCoreCmd = `uv run --project "${path.join(repoRoot, 'core')}" python -m chef_core`;
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'integration');

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-corpus-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', 'scripts/gen_corpus.py', '--out', corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
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

const waitJobs = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });

const cardCount = (l: Launched) => l.page.locator('.page-card').count();

test('real core: core is ready and lists the v0.1 and scan operations', async () => {
  const l = await open('vietnamese_text.pdf');
  const ping = await l.page.evaluate(() => window.chef.rpc('system.ping', {}));
  expect(ping.version).toBeTruthy();
  const ops = await l.page.evaluate(() => window.chef.rpc('ops.list', {}));
  const ids = ops.map((o) => o.id);
  // Other operations may be added later, so check that the required ones are present.
  for (const id of [
    'file.merge',
    'file.split',
    'page.delete',
    'page.duplicate',
    'page.extract',
    'page.insertBlank',
    'page.insertFromFile',
    'page.insertImages',
    'page.reorder',
    'page.rotate',
    'scan.fitSize',
    'scan.preview',
    'scan.rasterize',
  ]) {
    expect(ids).toContain(id);
  }
});

test('opens a Vietnamese PDF from the command line and searches without diacritics', async () => {
  const l = await open('vietnamese_text.pdf');
  await expect(l.page.getByRole('tab', { name: 'Form', exact: true })).toHaveCount(1);
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'viewer.png') });
  await l.page.keyboard.press('Control+f');
  await l.page.fill('.findbar__input', 'nghi dinh');
  await l.page.waitForSelector('.textLayer .highlight', { timeout: 15_000 });
  await expect(l.page.locator('.findbar__count')).toContainText('/');
  await l.page.screenshot({ path: path.join(shotsDir, 'search.png') });
  await l.page.getByRole('tab', { name: 'Quy trình', exact: true }).click();
  await expect(l.page.getByRole('button', { name: 'Tạo quy trình' })).toBeVisible();
  await expect(l.page.getByRole('button', { name: 'Thư mục tự động' })).toBeVisible();
  await expect(l.page.locator('.soon-note')).toHaveCount(0);
});

test('night reading changes the page display without modifying the PDF', async () => {
  const l = await open('vietnamese_text.pdf');
  const source = path.join(corpus, 'vietnamese_text.pdf');
  const original = fs.readFileSync(source);
  const page = l.page.locator('.pdfViewer .page').first();
  await page.locator('canvas').waitFor({ timeout: 30_000 });
  const toggle = l.page.getByRole('button', { name: 'Chế độ đọc ban đêm' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveCSS('filter', 'none');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveCSS('filter', 'invert(1) hue-rotate(180deg)');
  await toggle.click();
  await expect(page).toHaveCSS('filter', 'none');
  expect(fs.readFileSync(source)).toEqual(original);
});

test('side-by-side view navigates independently within the same document', async () => {
  const l = await open('outline_10p.pdf');
  await l.page.locator('.pdfViewer .page canvas').first().waitFor({ timeout: 30_000 });
  await l.page.getByRole('button', { name: 'Xem song song' }).click();
  const pane = l.page.locator('.compare-pane');
  await pane.locator('.pdfViewer .page canvas').first().waitFor({ timeout: 30_000 });
  const secondPage = pane.getByRole('spinbutton', { name: 'Trang bên phải' });
  await expect(secondPage).toHaveValue('1');
  await secondPage.fill('3');
  await expect(secondPage).toHaveValue('3');
  await expect(l.page.locator('.status__page-input')).toHaveValue('1');
  await l.app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never;
    },
    path.join(corpus, 'vietnamese_text.pdf'),
  );
  await l.page.keyboard.press('Control+o');
  await expect(l.page.locator('.doctab:not(.doctab--about)')).toHaveCount(2);
  const select = pane.getByRole('combobox', { name: 'Tài liệu bên phải' });
  await expect(select.locator('option')).toHaveCount(2);
  await select.selectOption({ label: 'outline_10p.pdf' });
  await expect(pane.locator('.pdfViewer .page')).toHaveCount(10);
  await l.page.getByRole('button', { name: 'Xem song song' }).click();
  await expect(pane).toHaveCount(0);
});

test('page organizer: delete, undo, duplicate and save through the real core', async () => {
  const l = await open('outline_10p.pdf');
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Trang');
  await l.page.waitForSelector('.page-card img', { timeout: 30_000 });
  expect(await cardCount(l)).toBe(10);

  await l.page.click('.page-card[data-index="0"]');
  await l.page.keyboard.press('Delete');
  await waitJobs(l);
  await l.page.waitForFunction(() => document.querySelectorAll('.page-card').length === 9);
  await l.page.keyboard.press('Control+z');
  await l.page.waitForFunction(() => document.querySelectorAll('.page-card').length === 10);

  // Duplicate page 1 (Ctrl+D) then verify via the core's session state.
  await l.page.click('.page-card[data-index="0"]');
  await l.page.keyboard.press('Control+d');
  await waitJobs(l);
  await l.page.waitForFunction(() => document.querySelectorAll('.page-card').length === 11);
  // Thumbnails must never show a stale image at a shifted index: card 2 is the copy of page 1.
  await l.page.waitForSelector('.page-card[data-index="1"] img', { timeout: 15_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'pages.png') });

  // Ctrl+S saves back to the source file through session.save; the dirty marker goes away.
  const src = path.join(corpus, 'outline_10p.pdf');
  const before = fs.statSync(src).mtimeMs;
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 15_000,
  });
  expect(fs.statSync(src).mtimeMs).toBeGreaterThan(before);
  // Re-open the saved file in the core directly and check the page count persisted.
  const pages = await l.page.evaluate(async (p) => {
    const r = await window.chef.rpc('session.open', { path: p });
    await window.chef.rpc('session.close', { sessionId: r.state.sessionId });
    return r.info.pageCount;
  }, src);
  expect(pages).toBe(11);
});

test('encrypted PDF asks for the password and opens with "1234"', async () => {
  const l = await open('encrypted_1234.pdf');
  const input = l.page.locator('input[type="password"]');
  await input.waitFor({ timeout: 30_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'password.png') });
  await input.fill('1234');
  await input.press('Enter');
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
});
