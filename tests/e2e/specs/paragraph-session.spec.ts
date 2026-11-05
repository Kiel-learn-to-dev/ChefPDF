/**
 * Paragraph session (1.1, D62): a click on text opens the paragraph for typing, like a word
 * processor. Built UI + Electron + the REAL Python core, on the text corpus.
 * - typing at the caret, Backspace and Delete, then a click outside writes the paragraph (one save);
 * - Esc leaves the file's bytes as they were;
 * - one Ctrl+Z after the write reverts the whole session;
 * - a character outside the font shows the chip that says which font takes over.
 * Requires `pnpm --filter @chef/ui build` and `uv`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const OLD_LINE = 'trong vòng 30 ngày';

let corpus = '';
let current = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

function check(args: string[]): Record<string, unknown> {
  const out = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreDir,
      'python',
      '-I',
      path.join(corpus, 'textedit_check.py'),
      current,
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-session-'));
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'textedit_corpus.py'), corpus],
    {
      cwd: repoRoot,
      stdio: 'ignore',
    },
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

/** Opens a fresh copy of the contract in edit mode. */
async function openEdit(): Promise<Launched> {
  current = path.join(corpus, `session-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.copyFileSync(path.join(corpus, 'contract.pdf'), current);
  launched = await launchUnderTest({ args: [current], env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  return l;
}

/** Clicks the centre of the line that holds OLD_LINE: a click on text opens the session. */
async function clickText(l: Launched): Promise<void> {
  const box = l.page.locator(`[data-testid="tedit-box"][data-text*="${OLD_LINE}"]`);
  await box.waitFor({ timeout: 30_000 });
  const b = await box.boundingBox();
  if (!b) throw new Error('text line has no box');
  await l.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(l.page.getByTestId('tedit-session')).toBeVisible({ timeout: 30_000 });
  await expect(l.page.getByTestId('tedit-caret')).toBeVisible();
}

/** Clicks the page margin: outside the paragraph, so the session is written. */
async function clickOutside(l: Launched): Promise<void> {
  const page = l.page.locator('.pdfViewer .page canvas').first();
  const b = await page.boundingBox();
  if (!b) throw new Error('page has no box');
  await l.page.mouse.click(b.x + 4, b.y + 4);
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 30_000 });
}

test('a click mid-line, typing, Backspace and Delete; a click outside writes the paragraph', async () => {
  test.setTimeout(180_000);
  const l = await openEdit();
  await clickText(l);
  await l.page.keyboard.press('Control+Home');
  await l.page.keyboard.type('Xác nhận: ');
  await l.page.keyboard.press('Backspace');
  await l.page.keyboard.press('Delete');
  await clickOutside(l);
  await l.page.keyboard.press('Control+s');
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 120_000 });
  const text = (check(['text', '0']) as { text: string }).text.replace(/\s+/g, ' ');
  expect(text).toContain('Xác nhận:');
  expect(text).toContain('hanh toán trong vòng 30 ngày');
});

test('Esc leaves the file as it was', async () => {
  test.setTimeout(120_000);
  const l = await openEdit();
  const before = sha256(current);
  await clickText(l);
  await l.page.keyboard.type('Thử');
  await l.page.keyboard.press('Escape');
  await expect(l.page.getByTestId('tedit-session')).toHaveCount(0, { timeout: 30_000 });
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0);
  expect(sha256(current)).toBe(before);
});

test('one Ctrl+Z after the write reverts the whole session', async () => {
  test.setTimeout(180_000);
  const l = await openEdit();
  await clickText(l);
  await l.page.keyboard.press('Control+Home');
  await l.page.keyboard.type('Tạm ');
  await clickOutside(l);
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(1, { timeout: 30_000 });
  await l.page.keyboard.press('Control+z');
  await l.page.keyboard.press('Control+s');
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 120_000 });
  const text = (check(['text', '0']) as { text: string }).text.replace(/\s+/g, ' ');
  expect(text).not.toContain('Tạm');
  expect(text).toContain('Thanh toán trong vòng 30 ngày');
});

test('a character outside the font shows the chip that says which font takes over', async () => {
  test.setTimeout(120_000);
  const l = await openEdit();
  await clickText(l);
  await l.page.keyboard.press('Control+End');
  await l.page.keyboard.type(' ớ');
  await expect(l.page.locator('.tedit-chip--warn').first()).toBeVisible({ timeout: 15_000 });
  await l.page.keyboard.press('Escape');
});
