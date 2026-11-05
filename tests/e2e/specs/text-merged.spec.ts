/**
 * Sửa chữ, one mode (D66): text is selected and edited, a new text box is placed where the page is
 * pressed (Thêm văn bản), and the objects are selected and removed in the same mode. Built UI +
 * Electron + the REAL Python core, on the text corpus and the objects corpus.
 * - the Chỉnh sửa tab has one Sửa chữ button; the old Thêm chữ and Chọn & sửa đối tượng are gone;
 * - Thêm văn bản writes a Vietnamese text where the page was pressed; Esc drops a box without writing;
 * - the font warning names the font by its family, once, in the format row (no internal id, no "X bằng X");
 * - an object is selected, nudged and deleted in the Sửa chữ mode, and the saved file shows it.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';
import { clickEdit, selectLine } from '../fixtures/textedit';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const OLD_LINE = 'trong vòng 30 ngày';
// Page 1 of objects.pdf: the red rectangle (points, top-left origin).
const RECT_CENTRE = { x: 200, y: 217 };
// A blank place on page 1 of the contract (points, top-left origin): below its text, in the viewport.
const BLANK = { x: 330, y: 380 };

let textCorpus = '';
let objectsCorpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

function checkText(args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(textCorpus, 'textedit_check.py'),
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

function checkObjects(args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(objectsCorpus, 'objects_check.py'),
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  textCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-merged-text-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(fixturesDir, 'textedit_corpus.py'),
      textCorpus,
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'textedit_check.py'),
    path.join(textCorpus, 'textedit_check.py'),
  );
  objectsCorpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-merged-objects-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(fixturesDir, 'objects_corpus.py'),
      objectsCorpus,
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'objects_check.py'),
    path.join(objectsCorpus, 'objects_check.py'),
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
  fs.rmSync(textCorpus, { recursive: true, force: true });
  fs.rmSync(objectsCorpus, { recursive: true, force: true });
});

/** Opens a fresh copy of a corpus file in the packaged-or-dev app with the real core. */
async function open(dir: string, file: string): Promise<Launched> {
  current = path.join(dir, `merged-${Date.now()}-${file}`);
  fs.copyFileSync(path.join(dir, file), current);
  launched = await launchUnderTest({ args: [current], env: { CHEF_CORE_CMD: realCoreCmd } });
  await launched.page.setViewportSize({ width: 1280, height: 800 });
  await launched.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  return launched;
}

const waitJobs = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });

const waitSaved = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });

/** Page 1 of the viewer: its viewport box and px per point. */
async function pageBox(l: Launched): Promise<{ left: number; top: number; scale: number }> {
  const box = await l.page
    .locator('.pdfViewer .page[data-page-number="1"] canvas')
    .first()
    .boundingBox();
  if (!box) throw new Error('page 1 has no box');
  return { left: box.x, top: box.y, scale: box.width / 612 };
}

async function enterSuaChu(l: Launched): Promise<void> {
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  await expect(l.page.locator('.status')).toContainText('Chế độ Chỉnh sửa');
}

test('one Sửa chữ button: the old Thêm chữ and Chọn & sửa đối tượng are gone', async () => {
  const l = await open(textCorpus, 'contract.pdf');
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await expect(l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' })).toHaveCount(1);
  await expect(l.page.locator('.toolbar__btn', { hasText: 'Thêm chữ' })).toHaveCount(0);
  await expect(l.page.locator('.toolbar__btn', { hasText: 'Chọn & sửa đối tượng' })).toHaveCount(0);
});

test('Thêm văn bản writes a Vietnamese text where the page was pressed; the saved file has it', async () => {
  test.setTimeout(180_000);
  const l = await open(textCorpus, 'contract.pdf');
  await enterSuaChu(l);
  const bar = l.page.getByRole('toolbar', { name: 'Định dạng chữ' });
  const add = bar.getByRole('button', { name: 'Thêm văn bản', exact: true });
  await add.click();
  await expect(add).toHaveAttribute('aria-pressed', 'true');

  const p = await pageBox(l);
  await l.page.mouse.click(p.left + BLANK.x * p.scale, p.top + BLANK.y * p.scale);
  const draft = l.page.getByTestId('tedit-draft');
  await expect(draft).toBeVisible({ timeout: 30_000 });
  await expect(draft).toBeFocused();
  const at = await draft.boundingBox();
  await l.page.keyboard.type('Ghi chú mới: đã kiểm tra');
  await l.page.keyboard.press('Control+Enter');
  await expect(draft).toHaveCount(0, { timeout: 60_000 });
  await waitJobs(l);
  // The written line sits where the page was pressed (same point, within the glyph box).
  const placed = await l.page
    .locator('[data-testid="tedit-box"][data-text*="Ghi chú mới"]')
    .first()
    .boundingBox();
  expect(placed && at).toBeTruthy();
  expect(Math.abs(placed!.x - at!.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(placed!.y - at!.y)).toBeLessThanOrEqual(12);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (checkText([current, 'text', '0']) as { text: string }).text.replace(/\s+/g, ' ');
  expect(text).toContain('Ghi chú mới: đã kiểm tra');

  // The added text is an ordinary text (D66): Sửa edits it, and the saved file has the edit.
  await selectLine(l.page, 'Ghi chú mới');
  await clickEdit(l.page);
  await l.page.keyboard.press('Control+End');
  await l.page.keyboard.type(' (đã sửa)');
  await l.page.keyboard.press('Control+Enter');
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 60_000 });
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const edited = (checkText([current, 'text', '0']) as { text: string }).text.replace(/\s+/g, ' ');
  expect(edited).toContain('Ghi chú mới: đã kiểm tra (đã sửa)');
});

test('Esc drops a new text box without writing: the file is not changed', async () => {
  test.setTimeout(120_000);
  const l = await open(textCorpus, 'contract.pdf');
  await enterSuaChu(l);
  await l.page.getByRole('button', { name: 'Thêm văn bản', exact: true }).click();
  const p = await pageBox(l);
  await l.page.mouse.click(p.left + BLANK.x * p.scale, p.top + BLANK.y * p.scale);
  await l.page.keyboard.type('không ghi');
  await l.page.keyboard.press('Escape');
  await expect(l.page.getByTestId('tedit-draft')).toHaveCount(0);
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0);
});

test('the font warning names the family, once, and sits in the format row', async () => {
  test.setTimeout(180_000);
  const l = await open(textCorpus, 'contract.pdf');
  await enterSuaChu(l);
  await selectLine(l.page, OLD_LINE);
  await clickEdit(l.page);
  // A character the original subset lacks: the full font of the same family writes it.
  await l.page.keyboard.press('Control+End');
  await l.page.keyboard.type(' ớ');

  const notes = l.page.locator('.tedit-fmt__notes .tedit-chip');
  await expect(notes.first()).toContainText('Be Vietnam Pro', { timeout: 30_000 });
  const texts = await notes.allInnerTexts();
  for (const text of texts) {
    expect(text).not.toContain('sys:');
    expect(text).not.toContain('+');
    expect(text).not.toMatch(/BeVietnamPro-Regular bằng BeVietnamPro-Regular/);
  }
  // The notes are inside the format row, which is inside the window: nothing spills over the panel.
  const row = await l.page.locator('.tedit-fmt').boundingBox();
  const chip = await notes.first().boundingBox();
  expect(row && chip).toBeTruthy();
  expect(chip!.x).toBeGreaterThanOrEqual(row!.x);
  expect(chip!.x + chip!.width).toBeLessThanOrEqual(row!.x + row!.width + 1);
  expect(chip!.y).toBeGreaterThanOrEqual(row!.y - 1);
  expect(chip!.y + chip!.height).toBeLessThanOrEqual(row!.y + row!.height + 1);

  // Written: the toast names the family too.
  await l.page.keyboard.press('Control+Enter');
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 60_000 });
  const toast = l.page.locator('[role="status"]').filter({ hasText: 'Be Vietnam Pro' });
  await expect(toast.first()).toBeVisible({ timeout: 30_000 });
  const toastText = await toast.first().innerText();
  expect(toastText).not.toContain('sys:');
  expect(toastText).not.toMatch(/BeVietnamPro-Regular bằng BeVietnamPro-Regular/);

  // The written text is saved: a dirty document would keep the app open after the test.
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
});

test('an object is selected, nudged and deleted in the Sửa chữ mode; the saved file shows it', async () => {
  test.setTimeout(180_000);
  const l = await open(objectsCorpus, 'objects.pdf');
  await enterSuaChu(l);
  await l.page.waitForSelector('[data-testid="object-box"]', { timeout: 30_000 });
  const p = await pageBox(l);
  await l.page.mouse.click(p.left + RECT_CENTRE.x * p.scale, p.top + RECT_CENTRE.y * p.scale);
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();
  await l.page.keyboard.press('ArrowRight');
  await waitJobs(l);
  // The nudge keeps the object selected: Delete then removes it.
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();
  await l.page.keyboard.press('Delete');
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const px = checkObjects([current, 'pixel', String(RECT_CENTRE.x), String(RECT_CENTRE.y)]);
  expect(px).toEqual({ rgb: [255, 255, 255] });
});

test('pressing text drops the object selection: Delete then leaves the rectangle alone', async () => {
  test.setTimeout(180_000);
  const l = await open(objectsCorpus, 'objects.pdf');
  await enterSuaChu(l);
  await l.page.waitForSelector('[data-testid="object-box"]', { timeout: 30_000 });
  const p = await pageBox(l);
  await l.page.mouse.click(p.left + RECT_CENTRE.x * p.scale, p.top + RECT_CENTRE.y * p.scale);
  await expect(l.page.locator('[data-testid="object-selection"]')).toBeVisible();
  const before = checkObjects([current, 'pixel', String(RECT_CENTRE.x), String(RECT_CENTRE.y)]);

  // A drag over the text line: the text is selected, the rectangle is no longer selected.
  await selectLine(l.page, 'Hello object');
  await expect(l.page.locator('[data-testid="object-selection"]')).toHaveCount(0);
  await l.page.keyboard.press('Delete');
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(checkObjects([current, 'pixel', String(RECT_CENTRE.x), String(RECT_CENTRE.y)])).toEqual(
    before,
  );
});

test('a new text box scrolled past the top of the viewer does not paint over the toolbar', async () => {
  test.setTimeout(120_000);
  const l = await open(textCorpus, 'contract.pdf');
  await enterSuaChu(l);
  await l.page.getByRole('button', { name: 'Thêm văn bản', exact: true }).click();
  const p = await pageBox(l);
  await l.page.mouse.click(p.left + BLANK.x * p.scale, p.top + BLANK.y * p.scale);
  const draft = l.page.getByTestId('tedit-draft');
  await expect(draft).toBeVisible({ timeout: 30_000 });

  // Scroll until the box straddles the top edge of the viewer: its top is above the edge, its
  // lower part is inside. A point just above the edge, inside the box, must not hit the box.
  const viewer = await l.page.locator('.viewer').boundingBox();
  const at = await draft.boundingBox();
  expect(viewer && at).toBeTruthy();
  const edge = viewer!.y;
  await l.page.locator('.viewer__scroll').evaluate(
    (el, delta) => {
      el.scrollTop += delta;
    },
    at!.y - (edge - 12),
  );
  await l.page.waitForTimeout(300);
  const moved = await draft.boundingBox();
  expect(moved!.y).toBeLessThan(edge);
  const hit = await l.page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('.tedit-layer') ? 'layer' : 'outside';
    },
    [moved!.x + 8, edge - 4] as [number, number],
  );
  expect(hit).toBe('outside');
  await l.page.screenshot({ path: path.join(os.tmpdir(), 'clip-scrolled.png') });
});

test('Sửa opens the selected word selected: typing replaces it, it is not appended', async () => {
  test.setTimeout(120_000);
  const l = await open(textCorpus, 'contract.pdf');
  await enterSuaChu(l);
  // Double click the word "vòng" in the middle of the line (the box is the whole line).
  const box = l.page.locator(`[data-testid="tedit-box"][data-text*="${OLD_LINE}"]`).first();
  await box.waitFor({ timeout: 30_000 });
  const b = await box.boundingBox();
  if (!b) throw new Error('no line box');
  await l.page.mouse.dblclick(b.x + b.width * 0.63, b.y + b.height / 2);
  await expect(l.page.getByTestId('tedit-selection').first()).toBeVisible({ timeout: 30_000 });
  await clickEdit(l.page);
  // The word is selected in the textbox too: typing replaces it.
  const input = l.page.locator('.tedit-sess__input');
  await expect
    .poll(() =>
      input.evaluate((el: HTMLTextAreaElement) =>
        el.value.slice(el.selectionStart!, el.selectionEnd!),
      ),
    )
    .toBe('vòng');
  await l.page.keyboard.type('X');
  await l.page.keyboard.press('Control+Enter');
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 60_000 });
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  const text = (checkText([current, 'text', '0']) as { text: string }).text.replace(/\s+/g, ' ');
  expect(text).toContain('trong X 30 ngày');
  expect(text).not.toContain('vòng');
});

test('Sửa chữ shows no box per text run; one dashed outline per paragraph', async () => {
  test.setTimeout(120_000);
  const l = await open(textCorpus, 'contract.pdf');
  await enterSuaChu(l);
  await l.page.waitForSelector('[data-testid="tedit-box"]', { timeout: 30_000 });
  // The text runs are not objects in this mode: no dashed box per word.
  await expect(l.page.locator('.obj-box--text')).toHaveCount(0);
  // One outline per editable paragraph on the visible pages.
  const paragraphs = await l.page
    .locator('[data-testid="tedit-box"]')
    .evaluateAll(
      (els) =>
        new Set(els.map((el) => el.getAttribute('data-paragraph') ?? '').filter(Boolean)).size,
    );
  expect(paragraphs).toBeGreaterThan(0);
  await expect(l.page.locator('.tedit-para')).toHaveCount(paragraphs);
});
