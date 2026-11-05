/**
 * Object edit end to end (D4, D5, E1): built UI + Electron shell + the REAL Python core.
 * (a) select a rectangle and delete it; (b) drag it by 50 pt; (c) erase a region over a text line;
 * (d) hide an optional-content layer with its eye toggle. Each result is checked on the saved file.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'objects');

// Page geometry of objects.pdf (points, top-left origin): the red rectangle and the text line.
const RECT_CENTRE = { x: 200, y: 217 };
const RECT_ONLY = { x: 110, y: 150 };
const TEXT_LINE = { x: 40, y: 470, x2: 300, y2: 510 };
const IMAGE_POINT = { x: 370, y: 640 };

let corpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs the check script of a saved file and returns its JSON output. */
function check(args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(corpus, 'objects_check.py'), ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-objects-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'objects_corpus.py'), corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'objects_check.py'),
    path.join(corpus, 'objects_check.py'),
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

/** Viewport box of page 1 and its px per point. */
async function pageBox(l: Launched): Promise<{ left: number; top: number; scale: number }> {
  const box = await l.page
    .locator('.pdfViewer .page[data-page-number="1"] canvas')
    .first()
    .boundingBox();
  if (!box) throw new Error('page 1 has no box');
  return { left: box.x, top: box.y, scale: box.width / 612 };
}

/** A point of the page (points, top-left origin) in viewport px. */
const at = (p: { left: number; top: number; scale: number }, pt: { x: number; y: number }) => ({
  x: p.left + pt.x * p.scale,
  y: p.top + pt.y * p.scale,
});

async function enterObjectMode(l: Launched): Promise<void> {
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  await l.page.waitForSelector('[data-testid="object-box"]', { timeout: 30_000 });
}

test('delete: a selected rectangle is removed; the saved file shows it white and keeps the text', async () => {
  const l = await open('objects.pdf');
  await waitViewer(l);
  await enterObjectMode(l);
  const p = await pageBox(l);
  const c = at(p, RECT_CENTRE);
  await l.page.mouse.click(c.x, c.y);
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();
  await l.page.keyboard.press('Delete');
  await waitJobs(l);
  await l.page.screenshot({ path: path.join(shotsDir, 'delete.png') });

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const px = check([current, 'pixel', String(RECT_CENTRE.x), String(RECT_CENTRE.y)]);
  expect(px).toEqual({ rgb: [255, 255, 255] });
  const text = check([current, 'text']) as { text: string };
  expect(text.text).toContain('Hello object');
});

test('move: dragging the rectangle by 50 pt moves it in the saved file', async () => {
  const l = await open('objects.pdf');
  await waitViewer(l);
  await enterObjectMode(l);
  const p = await pageBox(l);
  const from = at(p, RECT_CENTRE);
  await l.page.mouse.click(from.x, from.y);
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();
  // Press on the selected rectangle, drag 50 pt right and down, release.
  const to = at(p, { x: RECT_CENTRE.x + 50, y: RECT_CENTRE.y + 50 });
  await l.page.mouse.move(from.x, from.y);
  await l.page.mouse.down();
  await l.page.mouse.move(to.x, to.y, { steps: 12 });
  await l.page.mouse.up();
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  // The old place is white, the new place is red.
  expect(check([current, 'pixel', String(RECT_ONLY.x), String(RECT_ONLY.y)])).toEqual({
    rgb: [255, 255, 255],
  });
  expect(check([current, 'pixel', String(RECT_CENTRE.x + 50), String(RECT_CENTRE.y + 50)])).toEqual(
    { rgb: [255, 0, 0] },
  );
});

test('erase: a cut over the text line removes the text; the rectangle and the image stay', async () => {
  const l = await open('objects.pdf');
  await waitViewer(l);
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn[aria-label="Thêm"]').click();
  await l.page.getByRole('menuitem', { name: 'Tẩy vùng' }).click();
  await l.page.waitForSelector('[data-testid="erase-layer"]');
  const p = await pageBox(l);
  const a = at(p, { x: TEXT_LINE.x, y: TEXT_LINE.y });
  const b = at(p, { x: TEXT_LINE.x2, y: TEXT_LINE.y2 });
  await l.page.mouse.move(a.x, a.y);
  await l.page.mouse.down();
  await l.page.mouse.move(b.x, b.y, { steps: 8 });
  await l.page.mouse.up();
  await expect(l.page.locator('[data-testid="erase-bar"]')).toBeVisible();
  await l.page.locator('[data-testid="erase-bar"] button', { hasText: 'Áp dụng' }).click();
  await waitJobs(l);
  await l.page.screenshot({ path: path.join(shotsDir, 'erase.png') });

  await l.page.keyboard.press('Escape');
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = check([current, 'text']) as { text: string };
  expect(text.text).not.toContain('Hello object');
  expect(check([current, 'pixel', String(RECT_ONLY.x), String(RECT_ONLY.y)])).toEqual({
    rgb: [255, 0, 0],
  });
  const img = check([current, 'pixel', String(IMAGE_POINT.x), String(IMAGE_POINT.y)]) as {
    rgb: number[];
  };
  expect(img.rgb).not.toEqual([255, 255, 255]);
});

test('layers: the eye toggle hides the Watermark layer; the saved file has it OFF', async () => {
  const l = await open('layers.pdf');
  await waitViewer(l);
  await l.page.locator('.sidenav__tab[aria-label="Lớp"]').click();
  const row = l.page.locator('[data-testid="layer-row"][data-name="Watermark"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.locator('button').first().click();
  await expect(row.locator('button[aria-label="Hiện lớp"]')).toBeVisible({ timeout: 30_000 });
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(check([current, 'layeroff'])).toEqual({ off: ['Watermark'] });
});
