/**
 * Links and annotations end to end (D11, G1-G5, T7.05-T7.07): built UI + Electron shell + the REAL
 * Python core.
 * (c) a link is drawn by dragging on the page; the saved file has a /Link with the URI;
 * (d) a highlight is made from the text selection (set with a DOM Range on the text layer), a
 *     sticky note is added and answered; the notes list shows them after save and reopen. The
 *     highlight is also looked for in the page canvas that pdf.js renders (the open question: does
 *     pdf.js draw the new annotations?);
 * (e) flatten removes the annotation objects; the highlight pixels stay.
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

const LINK_URI = 'https://chef.vn/lien-he';
const QUOTE = 'Bên A là Công ty ABC';
const NOTE = 'Kiểm tra số liệu';
const REPLY = 'Đã sửa';

// Page 1 of contract.pdf (points, top-left origin): the company line is at y 74..86.
const LINE_BOX = { x0: 72, y0: 72, x1: 330, y1: 88 };
const NOTE_AT = { x: 400, y: 300 };

let corpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

function check(file: string, args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(corpus, 'textedit_check.py'),
      file,
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-annots-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'textedit_corpus.py'), corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(
    path.join(fixturesDir, 'textedit_check.py'),
    path.join(corpus, 'textedit_check.py'),
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

const open = async (): Promise<Launched> => {
  current = path.join(corpus, `run-${Date.now()}.pdf`);
  fs.copyFileSync(path.join(corpus, 'contract.pdf'), current);
  launched = await launchApp({ args: [current], env: { CHEF_CORE_CMD: realCoreCmd } });
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

/**
 * Yellow pixels of the page canvas that pdf.js painted, in a box of points (top-left origin).
 * A highlight over white paper gives many; black text and white paper give none.
 */
function canvasYellow(l: Launched, box: typeof LINE_BOX): Promise<number> {
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

/** Selects the text of the company line on page 1 with a DOM Range on the text layer. */
async function selectQuote(l: Launched): Promise<void> {
  await l.page.waitForSelector('.pdfViewer .page[data-page-number="1"] .textLayer span');
  await l.page.evaluate((quote) => {
    const spans = [
      ...document.querySelectorAll<HTMLElement>(
        '.pdfViewer .page[data-page-number="1"] .textLayer span',
      ),
    ];
    const span = spans.find((s) => s.textContent?.includes(quote));
    if (!span) throw new Error('quote not in the text layer');
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, QUOTE);
}

test('link: a rectangle dragged on the page becomes a link with the URI in the saved file', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.keyboard.press('Control+k');
  await l.page.locator('.palette__input').fill('Liên kết');
  await l.page.locator('[role="option"]').first().click();
  const dlg = l.page.getByRole('dialog');
  await dlg.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();

  const p = await pageBox(l);
  const from = at(p, { x: 100, y: 300 });
  const to = at(p, { x: 260, y: 330 });
  await l.page.mouse.move(from.x, from.y);
  await l.page.mouse.down();
  await l.page.mouse.move(to.x, to.y, { steps: 10 });
  await l.page.mouse.up();

  await l.page.locator('#ln-uri').fill(LINK_URI);
  await dlg.getByRole('button', { name: 'Lưu liên kết', exact: true }).click();
  await expect(dlg.getByRole('button', { name: 'Thêm liên kết', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await waitJobs(l);

  await l.page.keyboard.press('Escape');
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(check(current, ['links'])).toEqual({ uris: [LINK_URI] });
});

test('highlight, sticky note and reply: the list shows them after reopen; pdf.js draws the highlight', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Ghi chú');
  await l.page.locator('.sidenav__tab[aria-label="Ghi chú"]').click();

  await selectQuote(l);
  await l.page.keyboard.press('Control+Shift+H');
  const hl = l.page.locator('[data-testid="annot-item"][data-subtype="Highlight"]');
  await expect(hl).toBeVisible({ timeout: 30_000 });
  await expect(hl).toContainText(QUOTE);

  // Open question: does pdf.js paint the new highlight into the page canvas?
  await expect.poll(() => canvasYellow(l, LINE_BOX), { timeout: 20_000 }).toBeGreaterThan(300);

  // A sticky note at an empty spot of the page.
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

  // Reply to the note.
  await sticky.getByRole('button', { name: 'Trả lời', exact: true }).click();
  await sticky.getByRole('textbox', { name: 'Nội dung trả lời' }).fill(REPLY);
  await sticky.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(l.page.getByText(REPLY)).toBeVisible({ timeout: 30_000 });
  await waitJobs(l);

  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(check(current, ['annots', '0'])).toEqual({ subtypes: ['Highlight', 'Text', 'Text'] });

  // Reopen: the list reads the annotations from the saved file.
  await l.app.close();
  launched = await launchApp({ args: [current], env: { CHEF_CORE_CMD: realCoreCmd } });
  const again = launched.page;
  await again.setViewportSize({ width: 1280, height: 800 });
  await waitViewer(launched);
  await again.locator('.sidenav__tab[aria-label="Ghi chú"]').click();
  await expect(again.locator('[data-testid="annot-item"][data-subtype="Highlight"]')).toContainText(
    QUOTE,
    { timeout: 30_000 },
  );
  await expect(again.getByText(NOTE)).toBeVisible();
  await expect(again.getByText(REPLY)).toBeVisible();
});

test('flatten: the annotation objects go, the highlight pixels stay', async () => {
  const l = await open();
  await waitViewer(l);
  await l.page.click('.ftab >> text=Ghi chú');
  await l.page.locator('.sidenav__tab[aria-label="Ghi chú"]').click();
  await selectQuote(l);
  await l.page.keyboard.press('Control+Shift+H');
  await expect(l.page.locator('[data-testid="annot-item"][data-subtype="Highlight"]')).toBeVisible({
    timeout: 30_000,
  });
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);
  expect(check(current, ['annots', '0'])).toEqual({ subtypes: ['Highlight'] });

  await l.page.getByRole('button', { name: 'Làm phẳng ghi chú…' }).click();
  await l.page.getByRole('button', { name: 'Làm phẳng', exact: true }).click();
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  expect(check(current, ['annots', '0'])).toEqual({ subtypes: [] });
  const yellow = check(current, [
    'yellow',
    '0',
    String(LINE_BOX.x0),
    String(LINE_BOX.y0),
    String(LINE_BOX.x1),
    String(LINE_BOX.y1),
  ]) as {
    yellow: number;
  };
  expect(yellow.yellow).toBeGreaterThan(300);
});
