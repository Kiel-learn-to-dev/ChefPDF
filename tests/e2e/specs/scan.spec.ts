/**
 * "Chuyển thành bản scan" end to end: built UI + Electron shell + the REAL Python core.
 * Requires `pnpm --filter @chef/ui build` and `uv` (the core is launched with `uv run`).
 * Skipped automatically when the UI has not been built.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'scan');

/** Prints, for every page, how many images it draws and whether its content stream shows text. */
const PAGE_CHECK = `
import json, sys
import pikepdf

pdf = pikepdf.open(sys.argv[1])
rows = []
for page in pdf.pages:
    resources = page.obj.get('/Resources', pikepdf.Dictionary())
    xobjects = resources.get('/XObject', pikepdf.Dictionary())
    images = [x for x in xobjects.values() if x.get('/Subtype') == '/Image']
    shown = {str(operator) for _, operator in pikepdf.parse_content_stream(page)}
    rows.append({'images': len(images), 'text': bool(shown & {'Tj', 'TJ', "'", '"'})})
print(json.dumps({'pages': len(pdf.pages), 'rows': rows}))
`;

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-scan-corpus-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', 'scripts/gen_corpus.py', '--out', corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.writeFileSync(path.join(corpus, 'page_check.py'), PAGE_CHECK);
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
    timeout: 60_000,
  });

/** Opens the scan dialog from the Export tab toolbar. */
const openScanDialog = async (l: Launched) => {
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Xuất');
  await l.page.click('.toolbar__btn:has-text("Bản scan")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Chuyển thành bản scan');
};

/** Per-page image and text usage of a PDF, read with pikepdf in the core's environment. */
function pageReport(file: string): {
  pages: number;
  rows: { images: number; text: boolean }[];
} {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', path.join(corpus, 'page_check.py'), file],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as { pages: number; rows: { images: number; text: boolean }[] };
}

test('converts only the chosen pages to images, previews them and keeps the rest', async () => {
  const l = await open('outline_10p.pdf');
  await openScanDialog(l);

  // Pages 1-2 only; the preview is produced by the real core (debounced, latest wins).
  await l.page.fill('#scan-pages', '1-2');
  await l.page.waitForSelector('.scan-preview__pair img', { timeout: 60_000 });
  await expect(l.page.locator('.task__estimate')).toContainText('~');
  await expect(l.page.locator('.task__warnings')).toContainText('Chữ sẽ mất');
  await l.page.screenshot({ path: path.join(shotsDir, 'preview.png') });

  // K5: slider comparison and 100% zoom.
  await l.page.click('.segmented__item:has-text("Thanh trượt")');
  await expect(l.page.locator('.scan-cmp')).toBeVisible();
  await l.page.click('.segmented__item:has-text("100%")');
  await expect(l.page.locator('.scan-preview__view.is-actual')).toBeVisible();
  await l.page.screenshot({ path: path.join(shotsDir, 'compare.png') });

  // Apply through the job system, then the done view.
  await l.page.click('.dlg__footer >> text=Chuyển đổi');
  await expect(l.page.locator('.dlg__title')).toHaveText('Đã chuyển thành bản scan', {
    timeout: 120_000,
  });
  await l.page.click('.dlg__footer >> text=Đóng');
  await waitJobs(l);

  // Save back to the source file and check what the core wrote.
  const src = path.join(corpus, 'outline_10p.pdf');
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });
  const report = pageReport(src);
  expect(report.pages).toBe(10);
  expect(report.rows[0]).toEqual({ images: 1, text: false });
  expect(report.rows[1]).toEqual({ images: 1, text: false });
  expect(report.rows[2]?.text).toBe(true);
});

test('"Nén sao cho file ≤ X MB" reports when the target is out of reach', async () => {
  const l = await open('outline_10p.pdf');
  await openScanDialog(l);
  await l.page.fill('#scan-fit', '0.001');
  await l.page.click('.dlg__body >> text=Tìm thiết lập');
  await expect(l.page.locator('.scan__fit-result')).toContainText('Không đạt được');
  await l.page.screenshot({ path: path.join(shotsDir, 'fit.png') });
});

test('a document that is already signed cannot be converted', async () => {
  const l = await open('fake_signed.pdf');
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Xuất');
  await expect(l.page.locator('.toolbar__hint')).toHaveAttribute('title', /ký số/);
  await expect(l.page.locator('.toolbar__hint button')).toBeDisabled();
});
