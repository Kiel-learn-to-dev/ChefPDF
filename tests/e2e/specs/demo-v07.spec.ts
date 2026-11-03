/**
 * Demo of milestone v0.7 end to end: built UI + Electron shell + the REAL Python core.
 * Demo: "sửa một câu tiếng Việt trong hợp đồng, thay tên công ty toàn tài liệu, highlight và ghi chú".
 * A four-page Vietnamese contract with the company name on every page (six times in all).
 * In the app: (a) one Vietnamese sentence is replaced by text with letters the font subset does not
 * have; (b) "Công ty ABC" is replaced on the whole document; (c) the new sentence is highlighted and
 * gets a sticky note with a reply; the notes list filters to the highlight and exports it; (d) the
 * notes are flattened. After each save the file is read back: the text of every page, the glyphs of
 * the embedded fonts, the annotations, the pixels of the highlight. A second PDF next to it stays
 * byte-identical and opens.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');

const OLD_SENTENCE = 'Thanh toán trong vòng 30 ngày kể từ ngày nghiệm thu.';
/** Letters ư, ớ are not in the subset of the original font: the editor must substitute the font. */
const NEW_SENTENCE = 'Thanh toán trước ngày 15 tháng 12 năm 2026.';
const OLD_NAME = 'Công ty ABC';
const NEW_NAME = 'Công ty Hoa Sen';
const NOTE = 'Kiểm tra lại ngày thanh toán';
const REPLY = 'Đã sửa theo biên bản';
const EXPORT_CSV = 'ghi-chu-tomtat.csv';

// Page 1 (points, top-left origin): the new sentence sits at baseline y 640 (11 pt).
const SENTENCE_BOX = { x0: 70, y0: 140, x1: 420, y1: 160 };
const NOTE_AT = { x: 400, y: 300 };
const PAGES = 4;

let corpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs one of the check scripts with the core's Python environment and returns its JSON. */
function run(script: string, file: string, args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(corpus, script), file, ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
}

const textOf = (file: string, page: number): string =>
  (run('textedit_check.py', file, ['text', String(page)]) as { text: string }).text;

/** Whitespace-insensitive form: pdfium may break lines differently after an edit. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const sha = (file: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Yellow pixels of page 1 of a saved file, in the new sentence's box (points, top-left origin). */
const yellowInFile = (file: string): number =>
  (
    run('textedit_check.py', file, [
      'yellow',
      '0',
      String(SENTENCE_BOX.x0),
      String(SENTENCE_BOX.y0),
      String(SENTENCE_BOX.x1),
      String(SENTENCE_BOX.y1),
    ]) as { yellow: number }
  ).yellow;

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-demo-v07-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'demo_v07_corpus.py'), corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'textedit_check.py'),
    path.join(corpus, 'textedit_check.py'),
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'demo_v07_check.py'),
    path.join(corpus, 'demo_v07_check.py'),
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

const open = async (file: string): Promise<Launched> => {
  launched = await launchApp({ args: [file], env: { CHEF_CORE_CMD: realCoreCmd } });
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

/** Viewport box of page 1 (its canvas) and the px per point. */
async function pageBox(l: Launched): Promise<{ left: number; top: number; scale: number }> {
  const box = await l.page
    .locator('.pdfViewer .page[data-page-number="1"] canvas')
    .first()
    .boundingBox();
  if (!box) throw new Error('page 1 has no box');
  return { left: box.x, top: box.y, scale: box.width / 612 };
}

const at = (p: { left: number; top: number; scale: number }, pt: { x: number; y: number }) => ({
  x: p.left + pt.x * p.scale,
  y: p.top + pt.y * p.scale,
});

/** Yellow pixels that pdf.js painted on page 1 in a box of points (top-left origin). */
function canvasYellow(l: Launched, box: typeof SENTENCE_BOX): Promise<number> {
  return l.page.evaluate((b) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '.pdfViewer .page[data-page-number="1"] canvas',
    );
    if (!canvas) return -1;
    const r = canvas.getBoundingClientRect();
    const cssPerPt = r.width / 612;
    const pxPerCss = canvas.width / r.width;
    const x = Math.floor(b.x0 * cssPerPt * pxPerCss);
    const y = Math.floor(b.y0 * cssPerPt * pxPerCss);
    const w = Math.ceil((b.x1 - b.x0) * cssPerPt * pxPerCss);
    const h = Math.ceil((b.y1 - b.y0) * cssPerPt * pxPerCss);
    const data = canvas.getContext('2d')!.getImageData(x, y, w, h).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue] = [data[i]!, data[i + 1]!, data[i + 2]!];
      if (red > 200 && green > 180 && blue < 170) count++;
    }
    return count;
  }, box);
}

/** Selects the new sentence on page 1 with a DOM Range over the text layer. */
async function selectSentence(l: Launched): Promise<void> {
  await l.page.waitForSelector('.pdfViewer .page[data-page-number="1"] .textLayer span');
  await l.page.evaluate(() => {
    const spans = [
      ...document.querySelectorAll<HTMLElement>(
        '.pdfViewer .page[data-page-number="1"] .textLayer span',
      ),
    ];
    const first = spans.find((s) => s.textContent?.includes('Thanh toán'));
    const last = spans.find((s) => s.textContent?.includes('năm 2026'));
    if (!first || !last) throw new Error('sentence not in the text layer');
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

test('demo v0.7: edit a sentence, replace the company name, highlight and note, flatten', async () => {
  const original = path.join(corpus, 'hop_dong.pdf');
  const other = path.join(corpus, 'khac.pdf');
  const otherBefore = sha(other);
  const originalBefore = sha(original);
  // Text of every page before any change: the baseline the saved file is compared to.
  const before = [0, 1, 2, 3].map((i) => textOf(original, i));
  expect(before[0]).toContain(OLD_SENTENCE);
  expect(before.join(' ').split(OLD_NAME).length - 1).toBe(6);

  current = path.join(corpus, `run-${Date.now()}.pdf`);
  fs.copyFileSync(original, current);
  const l = await open(current);
  await waitViewer(l);

  // (a) One Vietnamese sentence is replaced in place.
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  const line = l.page.locator('[data-testid="tedit-box"][data-text*="Thanh toán trong vòng"]');
  await line.waitFor({ timeout: 30_000 });
  const bounds = await line.boundingBox();
  if (!bounds) throw new Error('sentence has no bounding box');
  await l.page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const input = l.page.locator('.tedit-editor__input');
  await expect(input).toBeVisible();
  await input.fill(NEW_SENTENCE);
  // The original font cannot write ư and ớ: the chip says which font takes over.
  await expect(l.page.locator('.tedit-chip--warn')).toBeVisible({ timeout: 15_000 });
  await input.press('Enter');
  await expect(l.page.locator('.tedit-editor')).toBeHidden({ timeout: 30_000 });
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  const afterEdit = textOf(current, 0);
  expect(norm(afterEdit)).toContain(NEW_SENTENCE);
  expect(afterEdit).not.toContain('trong vòng 30 ngày');
  expect(norm(afterEdit)).toContain('Bên A là Công ty ABC');
  // Every letter of the new sentence has a glyph in an embedded font of page 1 (no notdef boxes).
  const glyphs = run('demo_v07_check.py', current, ['glyphs', '0', NEW_SENTENCE]) as {
    missing: string[];
    fonts: number;
  };
  expect(glyphs.fonts).toBeGreaterThan(0);
  expect(glyphs.missing).toEqual([]);

  // (b) The company name is replaced on the whole document: preview, then replace all.
  await l.page.keyboard.press('Control+h');
  const dlg = l.page.getByRole('dialog');
  await dlg.locator('#fr-find').fill(OLD_NAME);
  await dlg.locator('#fr-replace').fill(NEW_NAME);
  await dlg.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(dlg.getByText('Tìm thấy 6 kết quả.')).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Thay tất cả', exact: true }).click();
  await expect(dlg).toBeHidden({ timeout: 30_000 });
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  for (let i = 0; i < PAGES; i++) {
    const text = textOf(current, i);
    expect(text, `page ${i + 1}`).not.toContain(OLD_NAME);
    // The text of the page is the old text with only the two edits applied.
    const expected = norm(before[i]!)
      .replace(OLD_SENTENCE, NEW_SENTENCE)
      .split(OLD_NAME)
      .join(NEW_NAME);
    expect(norm(text), `page ${i + 1}`).toBe(expected);
  }
  expect(norm(textOf(current, 1))).toContain(`Điều 2. Bên B cam kết hợp tác cùng ${NEW_NAME}`);

  // (c) The new sentence is highlighted, with a sticky note and a reply.
  await l.page.click('.ftab >> text=Ghi chú');
  await l.page.locator('.sidenav__tab[aria-label="Ghi chú"]').click();
  await selectSentence(l);
  await l.page.keyboard.press('Control+Shift+H');
  const hl = l.page.locator('[data-testid="annot-item"][data-subtype="Highlight"]');
  await expect(hl).toBeVisible({ timeout: 30_000 });
  await expect(hl).toContainText('Thanh toán');
  await expect.poll(() => canvasYellow(l, SENTENCE_BOX), { timeout: 20_000 }).toBeGreaterThan(300);

  await l.page.locator('.toolbar__btn', { hasText: 'Ghi chú dán' }).click();
  const p = await pageBox(l);
  const spot = at(p, NOTE_AT);
  await l.page.mouse.click(spot.x, spot.y);
  await l.page.getByLabel('Nội dung ghi chú').fill(NOTE);
  await l.page.locator('.annot-draft').getByRole('button', { name: 'Lưu', exact: true }).click();
  await waitJobs(l);
  await l.page.keyboard.press('Escape');
  const sticky = l.page.locator('[data-testid="annot-item"][data-subtype="Text"]');
  await expect(sticky).toContainText(NOTE, { timeout: 30_000 });
  await sticky.getByRole('button', { name: 'Trả lời', exact: true }).click();
  await sticky.getByRole('textbox', { name: 'Nội dung trả lời' }).fill(REPLY);
  await sticky.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(l.page.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  expect(run('textedit_check.py', current, ['annots', '0'])).toEqual({
    subtypes: ['Highlight', 'Text', 'Text'],
  });
  // The highlight is in the saved file's pixels too, over the new sentence.
  expect(yellowInFile(current)).toBeGreaterThan(300);

  // The list filters to the highlights; the export takes the same filter.
  await l.page.getByRole('combobox', { name: 'Loại ghi chú' }).click();
  await l.page.getByRole('option', { name: 'Tô sáng', exact: true }).click();
  await expect(sticky).toBeHidden();
  await expect(hl).toBeVisible();
  const csvPath = path.join(corpus, EXPORT_CSV);
  await l.app.evaluate(({ dialog }, out) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
  }, csvPath);
  await l.page.getByRole('combobox', { name: 'Định dạng xuất' }).click();
  await l.page.getByRole('option', { name: 'CSV', exact: true }).click();
  await l.page.getByRole('button', { name: 'Xuất ghi chú…' }).click();
  await expect.poll(() => fs.existsSync(csvPath), { timeout: 30_000 }).toBe(true);
  const csv = fs.readFileSync(csvPath, 'utf8');
  expect(csv).toContain('Thanh toán');
  expect(csv).not.toContain(NOTE);
  await l.page.getByRole('combobox', { name: 'Loại ghi chú' }).click();
  await l.page.getByRole('option', { name: 'Mọi loại', exact: true }).click();
  await expect(sticky).toBeVisible();

  // Reopen: the notes come back from the saved file.
  await l.app.close();
  launched = await open(current);
  await waitViewer(launched);
  await launched.page.locator('.sidenav__tab[aria-label="Ghi chú"]').click();
  await expect(
    launched.page.locator('[data-testid="annot-item"][data-subtype="Highlight"]'),
  ).toContainText('Thanh toán', { timeout: 30_000 });
  await expect(launched.page.getByText(NOTE)).toBeVisible();
  await expect(launched.page.getByText(REPLY)).toBeVisible();

  // (d) Flatten: the annotation objects go, the highlight pixels and the text stay.
  await launched.page.getByRole('button', { name: 'Làm phẳng ghi chú…' }).click();
  await launched.page.getByRole('button', { name: 'Làm phẳng', exact: true }).click();
  await waitJobs(launched);
  await launched.page.keyboard.press('Control+s');
  await waitSaved(launched);

  expect(run('textedit_check.py', current, ['annots', '0'])).toEqual({ subtypes: [] });
  expect(yellowInFile(current)).toBeGreaterThan(300);
  expect(norm(textOf(current, 0))).toContain(NEW_SENTENCE);
  expect(norm(textOf(current, 0))).toContain('Bên A là Công ty Hoa Sen');
  expect(
    (run('demo_v07_check.py', current, ['glyphs', '0', NEW_SENTENCE]) as { missing: string[] })
      .missing,
  ).toEqual([]);

  // The edited file opens with both readers; the other file and the original were never touched.
  expect(run('demo_v07_check.py', current, ['opens'])).toEqual({
    pikepdf_pages: PAGES,
    pdfium_pages: PAGES,
  });
  expect(sha(other)).toBe(otherBefore);
  expect(run('demo_v07_check.py', other, ['opens'])).toEqual({ pikepdf_pages: 1, pdfium_pages: 1 });
  expect(sha(original)).toBe(originalBefore);
});
