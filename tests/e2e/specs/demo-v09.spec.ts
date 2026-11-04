/**
 * Demo v0.9 (docs/TASKS.md): "tạo quy trình 'Nộp hồ sơ online', thả 20 file vào thư mục tự động,
 * lấy kết quả đã ký". Built UI + Electron shell + the REAL core. Requires `pnpm --filter @chef/ui
 * build` and `uv`; skipped automatically when the UI is not built.
 *
 * Scenario 1 (the Demo): the shipped preset "Nộp hồ sơ online" (merge: scan 200 dpi gray, compress
 * to 4 MB, sign) is loaded in the watched-folder dialog. Twenty PDFs are dropped into the inbox at
 * once; the folder runs the merge once on the whole batch and writes one signed dossier.
 *
 * Scenario 2 (T9.04 / T9.05): a per-file workflow ("Rã tài liệu ra Word") runs on three good PDFs
 * and one file that is not a PDF. The bad file fails alone, the watch keeps running, and no file is
 * processed twice over the following scans.
 *
 * Every output is measured again from the file itself by fixtures/demo_v09_check.py (pages, text,
 * signature validity against the throwaway certificate), not from what the app reports.
 *
 * NOT TESTED: the real token (PIN, CSP), Adobe Reader, a second instance of the app, a power cut
 * in the middle of a batch.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const presetsDir = path.join(coreDir, 'chef_core', 'resources', 'workflows');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const DEMO_PASSWORD = 'demo-v09-pass';
const MAX_DOSSIER_BYTES = 5_000_000;

interface PdfCheck {
  pages: number;
  bytes: number;
  textChars: number;
  signatures: { field: string; intact: boolean; valid: boolean; trusted: boolean }[];
}
interface DocxCheck {
  bytes: number;
  paragraphs: number;
  tables: number;
}

let workDir = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

function py(script: string, ...args: string[]): string {
  return execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', path.join(fixturesDir, script), ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 240_000 },
  );
}

function checkPdf(file: string, certificate: string): PdfCheck {
  return JSON.parse(py('demo_v09_check.py', 'pdf', file, certificate)) as PdfCheck;
}

function checkDocx(file: string): DocxCheck {
  return JSON.parse(py('demo_v09_check.py', 'docx', file)) as DocxCheck;
}

function pdfsIn(folder: string): string[] {
  return fs
    .readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith('.pdf'))
    .sort();
}

/** Opens "Thư mục tự động" from the command palette (the palette may need focus first). */
async function openWatchDialog(l: Launched): Promise<Locator> {
  await l.page.getByRole('button', { name: /Tìm lệnh/ }).click();
  await l.page.locator('.palette__input').fill('Thư mục tự động');
  await l.page.getByText('Thư mục tự động', { exact: true }).last().click();
  const dialog = l.page.getByRole('dialog', { name: 'Thư mục tự động' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Input of a variable or secret field in the validation block, found by its label text. */
function fieldInput(dialog: Locator, label: string): Locator {
  return dialog.locator('.watch-validation .field').filter({ hasText: label }).locator('input');
}

/** Loads a workflow JSON through the dialog's own button, with the native picker stubbed. */
async function loadWorkflowFile(l: Launched, dialog: Locator, file: string) {
  await l.app.evaluate(({ dialog: nativeDialog }, target) => {
    nativeDialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
  }, file);
  await dialog.getByRole('button', { name: 'Mở JSON quy trình' }).click();
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-demo-v09-'));
  py('demo_v09_corpus.py', workDir);
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
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('20 files dropped into the watched folder come out as one signed dossier (Nộp hồ sơ online)', async () => {
  test.setTimeout(600_000);
  const inbox = path.join(workDir, 'inbox-ho-so');
  const outbox = path.join(workDir, 'outbox-ho-so');
  const certificate = path.join(workDir, 'chu-ky-cert.der');
  fs.mkdirSync(inbox);
  fs.mkdirSync(outbox);

  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  const dialog = await openWatchDialog(l);
  await loadWorkflowFile(l, dialog, path.join(presetsDir, '01-nop-ho-so-online.json'));
  await expect(dialog.getByText('Nộp hồ sơ online', { exact: true })).toBeVisible();

  await dialog.getByPlaceholder('/path/to/inbox').fill(inbox);
  await dialog.getByPlaceholder('/path/to/output').fill(outbox);
  await dialog.getByRole('spinbutton').nth(0).fill('1');
  await dialog.getByRole('spinbutton').nth(1).fill('2');
  await dialog.getByRole('button', { name: 'Kiểm tra quy trình' }).click();
  await expect(dialog.locator('.watch-validation.is-valid')).toBeVisible({ timeout: 30_000 });
  await fieldInput(dialog, '{{pfxPath}}').fill(path.join(workDir, 'chu-ky.pfx'));
  await fieldInput(dialog, 'password').fill(DEMO_PASSWORD);
  await dialog.getByRole('button', { name: 'Bắt đầu theo dõi' }).click();
  await expect(dialog.getByText('Đang theo dõi', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Twenty PDFs land in the inbox within a second: one scan sees the whole batch.
  const dossier = path.join(workDir, 'ho-so');
  for (const name of fs.readdirSync(dossier)) {
    fs.copyFileSync(path.join(dossier, name), path.join(inbox, name));
  }
  expect(pdfsIn(inbox)).toHaveLength(20);

  const rows = dialog.locator('.watch-results li');
  await expect(rows).toHaveCount(1, { timeout: 300_000 });
  await expect(rows.first().locator('.watch-result-status--done')).toBeVisible();

  // The result is one file, measured from the file itself.
  const results = pdfsIn(outbox);
  expect(results).toHaveLength(1);
  const report = checkPdf(path.join(outbox, results[0]!), certificate);
  expect(report.pages).toBe(40);
  expect(report.bytes).toBeLessThanOrEqual(MAX_DOSSIER_BYTES);
  // No text left: every page was rasterized, so the scan step ran before the signature.
  expect(report.textChars).toBe(0);
  expect(report.signatures).toHaveLength(1);
  expect(report.signatures[0]).toMatchObject({ intact: true, valid: true, trusted: true });
  // The originals stay where they were.
  expect(pdfsIn(inbox)).toHaveLength(20);

  await dialog.getByRole('button', { name: 'Dừng sau đợt hiện tại' }).click();
  await expect(dialog.getByText('Đã dừng', { exact: true })).toBeVisible({ timeout: 30_000 });
});

test('one bad file in a per-file batch fails alone; the watch keeps going and runs no file twice', async () => {
  test.setTimeout(420_000);
  const inbox = path.join(workDir, 'inbox-word');
  const outbox = path.join(workDir, 'outbox-word');
  fs.mkdirSync(inbox);
  fs.mkdirSync(outbox);
  const batch = path.join(workDir, 'ra-word');
  for (const name of fs.readdirSync(batch)) {
    fs.copyFileSync(path.join(batch, name), path.join(inbox, name));
  }
  expect(fs.readdirSync(inbox)).toHaveLength(4);

  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  const dialog = await openWatchDialog(l);
  await loadWorkflowFile(l, dialog, path.join(presetsDir, '05-ra-word.json'));
  await expect(dialog.getByText('Rã tài liệu ra Word', { exact: true })).toBeVisible();
  await dialog.getByPlaceholder('/path/to/inbox').fill(inbox);
  await dialog.getByPlaceholder('/path/to/output').fill(outbox);
  await dialog.getByRole('spinbutton').nth(0).fill('1');
  await dialog.getByRole('spinbutton').nth(1).fill('0');
  await dialog.getByRole('button', { name: 'Bắt đầu theo dõi' }).click();

  const rows = dialog.locator('.watch-results li');
  await expect(rows).toHaveCount(4, { timeout: 300_000 });
  await expect(rows.locator('.watch-result-status--done')).toHaveCount(3);
  await expect(rows.locator('.watch-result-status--failed')).toHaveCount(1);
  // The batch did not stop at the bad file.
  await expect(dialog.getByText('Đang theo dõi', { exact: true })).toBeVisible();

  // Negative check: let several more scans run. Done files are in the ledger, so nothing repeats.
  await new Promise((resolve) => setTimeout(resolve, 4_500));
  await expect(rows).toHaveCount(4);
  const words = fs.readdirSync(outbox).filter((name) => name.toLowerCase().endsWith('.docx'));
  expect(words).toHaveLength(3);
  for (const name of words) {
    const doc = checkDocx(path.join(outbox, name));
    expect(doc.paragraphs).toBeGreaterThan(0);
  }

  await dialog.getByRole('button', { name: 'Dừng sau đợt hiện tại' }).click();
  await expect(dialog.getByText('Đã dừng', { exact: true })).toBeVisible({ timeout: 30_000 });
});
