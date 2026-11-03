/**
 * Content engine end to end (E4, D6): built UI + Electron shell + the REAL Python core.
 * (a) "Gỡ đối tượng giống thế này": a header picked on page 1 is found on all three pages and
 *     removed; the saved file has no header text and keeps the body text of each page.
 * (b) Image: a blue image block is picked and inverted ("Đảo màu"); the saved file shows the
 *     inverted colour at the same place.
 * (c) Image: "Thay ảnh" puts a red PNG in the place of the blue block (the file picker is stubbed).
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped when the UI has not been built.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'content-v06');
const FONT = path.join(repoRoot, 'tests', 'corpus', 'fonts', 'BeVietnamPro-Regular.ttf');
const PAGE_WIDTH_PT = 595.27; // A4
const HEADER_POINT = { x: 80, y: 38 }; // points, top-left origin: inside "Logo mẫu"
const IMAGE_POINT = { x: 172, y: 292 }; // centre of the blue block
const BLUE = [40, 120, 200];
const INVERTED = [215, 135, 55];
const RED = [200, 30, 30];

let corpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs the check script of a file (args after the file) and returns its JSON output. */
function check(file: string, ...args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(corpus, 'objects_check.py'),
      file,
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

/** The text of every page of a saved file (redact_check.py reads all pages). */
function allText(file: string): string {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(corpus, 'redact_check.py'),
      file,
      'text',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { text: string }).text;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-content-v06-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(fixturesDir, 'content_v06_corpus.py'),
      corpus,
      FONT,
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'objects_check.py'),
    path.join(corpus, 'objects_check.py'),
  );
  fs.copyFileSync(path.join(fixturesDir, 'redact_check.py'), path.join(corpus, 'redact_check.py'));
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

/** Opens a fresh copy of a corpus file (each test starts from the same document). */
const open = async (file: string): Promise<Launched> => {
  current = path.join(corpus, `run-${file}`);
  fs.copyFileSync(path.join(corpus, file), current);
  launched = await launchApp({
    args: [current],
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

/** Runs a command from the palette (Ctrl+K): its title typed, the first match picked. */
async function runCommand(l: Launched, title: string): Promise<void> {
  await l.page.keyboard.press('Control+k');
  await l.page.locator('.palette__input').fill(title);
  await l.page.locator('[role="option"]').first().click();
}

/** Viewport position of a point of page 1 (points, top-left origin). */
async function pagePoint(
  l: Launched,
  pt: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await l.page
    .locator('.pdfViewer .page[data-page-number="1"] canvas')
    .first()
    .boundingBox();
  if (!box) throw new Error('page 1 has no box');
  const scale = box.width / PAGE_WIDTH_PT;
  return { x: box.x + pt.x * scale, y: box.y + pt.y * scale };
}

test('similar: the header picked on page 1 is removed from all three pages', async () => {
  const l = await open('similar.pdf');
  await waitViewer(l);
  await runCommand(l, 'Gỡ đối tượng giống thế này');
  await expect(l.page.locator('.dlg__title')).toHaveText('Gỡ đối tượng giống thế này');

  await l.page
    .locator('.dlg__body')
    .getByRole('button', { name: 'Chọn đối tượng trên trang…' })
    .click();
  const p = await pagePoint(l, HEADER_POINT);
  await l.page.mouse.click(p.x, p.y);
  await l.page.locator('.ov-bar').getByRole('button', { name: 'Xong', exact: true }).click();
  await expect(l.page.locator('.dlg__body')).toContainText('Đã chọn:', { timeout: 30_000 });

  await l.page
    .locator('.dlg__body')
    .getByRole('button', { name: 'Xem trước', exact: true })
    .click();
  await expect(l.page.locator('.dlg__body')).toContainText(
    'Tìm thấy 3 đối tượng giống nhau trên 3 trang.',
    { timeout: 30_000 },
  );
  await l.page.screenshot({ path: path.join(shotsDir, 'similar-preview.png') });

  await l.page.locator('.dlg__footer').getByRole('button', { name: 'Gỡ 3 đối tượng' }).click();
  await expect(l.page.locator('.dlg__body')).toContainText('Đã gỡ 3 đối tượng.', {
    timeout: 60_000,
  });

  await l.page.keyboard.press('Escape');
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  const text = allText(current);
  expect(text).not.toContain('Logo mẫu');
  expect(text).toContain('Nội dung trang 1 giữ lại.');
  expect(text).toContain('Nội dung trang 3 giữ lại.');
});

test('image: the blue block is inverted with "Đảo màu" and the saved file shows it', async () => {
  const src = path.join(corpus, 'image.pdf');
  const before = check(src, 'pixel', String(IMAGE_POINT.x), String(IMAGE_POINT.y)) as {
    rgb: number[];
  };
  expect(before.rgb).toEqual(BLUE);

  const l = await open('image.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Chọn & sửa đối tượng' }).click();
  await l.page.waitForSelector('[data-testid="object-box"]', { timeout: 30_000 });
  const p = await pagePoint(l, IMAGE_POINT);
  await l.page.mouse.click(p.x, p.y);
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();

  await l.page.getByRole('button', { name: 'Chỉnh ảnh', exact: true }).click();
  await l.page.getByRole('checkbox', { name: 'Đảo màu' }).check();
  await l.page.getByRole('button', { name: 'Áp dụng chỉnh ảnh', exact: true }).click();
  await waitJobs(l);
  await l.page.screenshot({ path: path.join(shotsDir, 'image-invert.png') });

  await l.page.keyboard.press('Escape');
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const after = check(current, 'pixel', String(IMAGE_POINT.x), String(IMAGE_POINT.y)) as {
    rgb: number[];
  };
  INVERTED.forEach((want, i) => {
    expect(Math.abs((after.rgb[i] ?? NaN) - want)).toBeLessThanOrEqual(4);
  });
});

test('image: "Thay ảnh" puts the picked PNG in the place of the blue block', async () => {
  const l = await open('image.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Chọn & sửa đối tượng' }).click();
  await l.page.waitForSelector('[data-testid="object-box"]', { timeout: 30_000 });
  const p = await pagePoint(l, IMAGE_POINT);
  await l.page.mouse.click(p.x, p.y);
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();

  // The file picker of the desktop shell returns the red PNG of the corpus.
  const red = path.join(corpus, 'red.png');
  await l.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, red);
  await l.page.getByRole('button', { name: 'Thay ảnh…' }).click();
  await waitJobs(l);
  await l.page.screenshot({ path: path.join(shotsDir, 'image-replace.png') });

  await l.page.keyboard.press('Escape');
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const after = check(current, 'pixel', String(IMAGE_POINT.x), String(IMAGE_POINT.y)) as {
    rgb: number[];
  };
  RED.forEach((want, i) => {
    expect(Math.abs((after.rgb[i] ?? NaN) - want)).toBeLessThanOrEqual(6);
  });
});
