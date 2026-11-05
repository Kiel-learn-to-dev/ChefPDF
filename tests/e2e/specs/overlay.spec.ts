/**
 * Overlay tools (v0.4 UI: "Chỉnh sửa") end to end: built UI + Electron shell + the REAL Python core.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped when the UI is not built.
 *
 * The results are read back with the core's own Python environment (pypdfium2 for text and
 * positions, pikepdf for the Chef PDF marker), not with the UI.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'overlay');
const FONT = path.join(repoRoot, 'tests', 'corpus', 'fonts', 'BeVietnamPro-Regular.ttf');

/** Three A4 pages, each with one line of Vietnamese text: ba-trang.pdf. */
const MAKE_THREE = `
import sys
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
pdfmetrics.registerFont(TTFont('BeVietnamPro', sys.argv[2]))
c = canvas.Canvas(str(out / 'ba-trang.pdf'), pagesize=A4)
for i in range(1, 4):
    c.setFont('BeVietnamPro', 12)
    c.drawString(72, 600, f'Nội dung trang {i}')
    c.showPage()
c.save()
print('ok')
`;

/** Text of every page and the text in the top 120 pt of each page (page numbers live there). */
const EXTRACT = `
import json, sys
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(sys.argv[1])
rows = []
for i in range(len(pdf)):
    page = pdf[i]
    width, height = page.get_size()
    tp = page.get_textpage()
    rows.append({
        'text': tp.get_text_range(),
        'top': tp.get_text_bounded(0, height - 120, width, height),
    })
print(json.dumps(rows))
`;

/** Whether the saved file holds Chef PDF's overlay marker (BDC /ChefOverlay). */
const MARKER = `
import json, sys
import pikepdf

pdf = pikepdf.open(sys.argv[1])
found = False
for page in pdf.pages:
    page.contents_coalesce()
    if b'ChefOverlay' in bytes(page.Contents.read_bytes()):
        found = True
print(json.dumps({'marker': found}))
`;

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-overlay-corpus-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', 'scripts/gen_corpus.py', '--out', corpus],
    {
      cwd: repoRoot,
      stdio: 'ignore',
    },
  );
  execFileSync('uv', ['run', '--project', coreDir, 'python', '-c', MAKE_THREE, corpus, FONT], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  fs.writeFileSync(path.join(corpus, 'extract.py'), EXTRACT);
  fs.writeFileSync(path.join(corpus, 'marker.py'), MARKER);
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

/** A fresh copy of a corpus file, so that every test saves into its own file. */
function copyOf(source: string, name: string): string {
  const target = path.join(corpus, name);
  fs.copyFileSync(path.join(corpus, source), target);
  return target;
}

const open = async (file: string): Promise<Launched> => {
  launched = await launchApp({
    args: [file],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  await launched.page.setViewportSize({ width: 1280, height: 800 });
  await launched.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  return launched;
};

/** Switches to the "Chỉnh sửa" tab of the open document. */
const openEditTab = async (l: Launched) => {
  await l.page.click('.ftab >> text=Chỉnh sửa');
};

/** Ctrl+S and wait until the document is no longer dirty. */
const saveInPlace = async (l: Launched) => {
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 60_000,
  });
};

/** Text per page, and the top band text per page, read by the core's pypdfium2. */
function pageTexts(file: string): { text: string; top: string }[] {
  const script = path.join(corpus, 'extract.py');
  const out = execFileSync('uv', ['run', '--project', coreDir, 'python', script, file], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop() ?? '[]') as { text: string; top: string }[];
}

/** Whether the file carries Chef PDF's overlay marker. */
function hasMarker(file: string): boolean {
  const script = path.join(corpus, 'marker.py');
  const out = execFileSync('uv', ['run', '--project', coreDir, 'python', script, file], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { marker: boolean }).marker;
}

/** Makes the next file dialogs return the given answers, one per dialog, in order. */
async function stubPicks(l: Launched, answers: string[][]): Promise<void> {
  await l.app.evaluate(({ dialog }, list) => {
    let i = 0;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list[i++] ?? [] });
  }, answers);
}

test('adds a Vietnamese text to page 1 and the saved file has it', async () => {
  const file = copyOf('outline_10p.pdf', 'text.pdf');
  const l = await open(file);
  await openEditTab(l);
  // The options of a new text (size, colour, pages) are in the Sửa chữ format row (D66).
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  await l.page
    .getByRole('toolbar', { name: 'Định dạng chữ' })
    .getByRole('button', { name: 'Tùy chọn…' })
    .click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Thêm chữ');

  await l.page.fill('#ov-text-content', 'Bản sao có kiểm soát');
  await expect(l.page.getByTestId('overlay-text-preview')).toContainText('Bản sao có kiểm soát');
  await l.page.screenshot({ path: path.join(shotsDir, 'add-text.png') });
  await l.page.click('.dlg__footer >> text=Áp dụng');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });

  await saveInPlace(l);
  const pages = pageTexts(file);
  expect(pages[0]!.text).toContain('Bản sao có kiểm soát');
  expect(pages[1]!.text).not.toContain('Bản sao có kiểm soát');
});

test('page numbers with the NĐ 30 preset: none on page 1, 2 and 3 at the top', async () => {
  const file = copyOf('ba-trang.pdf', 'so-trang.pdf');
  const l = await open(file);
  await openEditTab(l);
  await l.page.click('.toolbar__btn:has-text("Số trang")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Số trang');

  await l.page.click('.dlg__body >> text=Theo Nghị định 30/2020/NĐ-CP');
  await expect(l.page.getByTestId('overlay-nd30-explain')).toBeVisible();
  await l.page.click('#ov-num-choice');
  await l.page.getByRole('option', { name: 'Tất cả (3 trang)' }).click();
  await l.page.screenshot({ path: path.join(shotsDir, 'page-numbers.png') });
  await l.page.click('.dlg__footer >> text=Áp dụng');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });

  await saveInPlace(l);
  const pages = pageTexts(file);
  expect(pages).toHaveLength(3);
  expect(pages[0]!.top.trim()).toBe('');
  expect(pages[1]!.top.trim()).toBe('2');
  expect(pages[2]!.top.trim()).toBe('3');
});

test('a watermark is listed by the overlay manager and "Xóa" removes it from the file', async () => {
  const file = copyOf('outline_10p.pdf', 'watermark.pdf');
  const l = await open(file);
  await openEditTab(l);
  await l.page.click('.toolbar__btn:has-text("Watermark")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Watermark');
  await l.page.click('.dlg__footer >> text=Áp dụng');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });
  await saveInPlace(l);
  expect(hasMarker(file)).toBe(true);

  // Mục này nằm trong menu "⋯" của tab Chỉnh sửa (thanh công cụ vừa 1280px)
  await l.page.click('.toolbar__btn[aria-label="Thêm"]');
  await l.page.getByRole('menuitem', { name: 'Đã thêm vào tài liệu' }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Đã thêm vào tài liệu');
  const row = l.page.locator('[data-testid="overlay-list"] [data-kind="watermark"]');
  await expect(row).toHaveCount(1);
  await row.click();
  await l.page.click('.ov-manager__actions >> button:has-text("Xóa")');
  await expect(l.page.getByTestId('overlay-empty')).toBeVisible({ timeout: 60_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'manager-empty.png') });
  await l.page.keyboard.press('Escape');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0);

  await saveInPlace(l);
  expect(hasMarker(file)).toBe(false);
});

test('a signed document disables the edit buttons and says why', async () => {
  const l = await open(path.join(corpus, 'fake_signed.pdf'));
  await openEditTab(l);
  const labels = ['Sửa chữ', 'Thêm ảnh', 'Watermark', 'Header/Footer', 'Số trang', 'Mã QR/vạch'];
  for (const label of labels) {
    const hint = l.page.locator('.toolbar__hint', {
      has: l.page.locator(`button:has-text("${label}")`),
    });
    await expect(hint).toHaveAttribute('title', /ký số/);
    await expect(hint.locator('button')).toBeDisabled();
  }
  // "Giấy tiêu đề" nằm trong menu "⋯" (thanh công cụ vừa 1280px): vẫn bị khóa
  await l.page.click('.toolbar__btn[aria-label="Thêm"]');
  await expect(l.page.getByRole('menuitem', { name: 'Giấy tiêu đề' })).toBeDisabled();
  await l.page.keyboard.press('Escape');
});

test('Bates numbering from the start screen numbers two files and writes the results', async () => {
  const a = copyOf('ba-trang.pdf', 'bates-a.pdf');
  const b = copyOf('ba-trang.pdf', 'bates-b.pdf');
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });

  await stubPicks(l, [[a, b]]);
  await l.page.locator('.tile', { hasText: 'Đánh số Bates' }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Đánh số Bates');
  await l.page.getByRole('button', { name: 'Thêm file PDF…', exact: true }).click();
  await expect(l.page.getByTestId('bates-file')).toHaveCount(2);

  await l.page.click('.dlg__footer >> text=Đánh số');
  await expect(l.page.getByTestId('bates-results')).toBeVisible({ timeout: 120_000 });
  await expect(l.page.locator('[data-testid="bates-results"] tr[data-status="done"]')).toHaveCount(
    2,
  );
  await l.page.screenshot({ path: path.join(shotsDir, 'bates.png') });

  const outA = pageTexts(a.replace(/\.pdf$/, '_bates.pdf'));
  expect(outA[0]!.text).toContain('HS-000001');
  expect(outA[2]!.text).toContain('HS-000003');
  const outB = pageTexts(b.replace(/\.pdf$/, '_bates.pdf'));
  expect(outB[0]!.text).toContain('HS-000004');
});
