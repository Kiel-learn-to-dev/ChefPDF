/**
 * Format bar (D14, 1.1): built UI + Electron shell + the REAL Python core.
 * A click on a line selects its paragraph; the bar then changes bold, alignment, line spacing and
 * size at once. Each change keeps the paragraph selected (no STALE_OBJECT_IDS), and one Ctrl+Z undoes
 * exactly one change. With CHEF_E2E_EXE set it runs the packaged exe. Requires `pnpm --filter
 * @chef/ui build` and `uv`.
 */
import { execFileSync } from 'node:child_process';
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
let launched: Launched | null = null;

/** Runs the check script of the corpus on a saved file and returns its JSON output. */
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

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-format-row-'));
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

test('format bar: bold, centre and size in a row keep the paragraph; one Ctrl+Z is one change', async () => {
  test.setTimeout(180_000);
  const file = path.join(corpus, `format-row-${Date.now()}.pdf`);
  fs.copyFileSync(path.join(corpus, 'contract.pdf'), file);
  launched = await launchUnderTest({ args: [file], env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  // B12: the status bar tells that the pages have a text layer.
  await expect(l.page.locator('.status')).toContainText('Có chữ', { timeout: 30_000 });

  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn', { hasText: 'Sửa chữ' }).click();
  const box = l.page.locator(`[data-testid="tedit-box"][data-text*="${OLD_LINE}"]`);
  await box.waitFor({ timeout: 30_000 });
  const bounds = await box.boundingBox();
  if (!bounds) throw new Error('Text line has no bounding box');
  await l.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  const bar = l.page.getByRole('toolbar', { name: 'Định dạng chữ' });
  const bold = bar.getByRole('button', { name: 'In đậm' });
  const size = bar.getByLabel('Cỡ chữ (pt)');
  const bigger = bar.getByRole('button', { name: 'Tăng cỡ chữ' });
  const align = bar.getByRole('combobox', { name: 'Căn lề' });

  await expect(bold).toBeEnabled({ timeout: 30_000 });
  const start = Number(await size.inputValue());
  expect(start).toBeGreaterThan(0);
  const alignStart = (await align.textContent())?.trim() ?? '';
  expect(alignStart).not.toBe('');

  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await align.click();
  await l.page.getByRole('option', { name: 'Giữa' }).click();
  await expect(align).toHaveText(/Giữa/, { timeout: 30_000 });
  const spacing = bar.getByLabel('Khoảng dòng (pt)');
  await spacing.fill('16');
  await spacing.press('Enter');
  await expect(bold).toBeEnabled({ timeout: 30_000 });
  await expect(spacing).toHaveValue('');
  await bigger.click();
  await expect(size).toHaveValue(String(start + 1), { timeout: 30_000 });

  // The paragraph is still selected after each change: the bar stays enabled and shows the new state.
  await expect(bold).toBeEnabled();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(align).toHaveText(/Giữa/);
  await expect(l.page.locator('[role="alert"]')).toHaveCount(0);

  // On disk every line of the paragraph has the change, not only the first line.
  await l.page.keyboard.press('Control+s');
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 120_000 });
  const lineTexts = await l.page
    .locator('[data-testid="tedit-box"].tedit-box--selected')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-text') ?? ''));
  expect(lineTexts.length).toBeGreaterThanOrEqual(2);
  for (const text of lineTexts) {
    const saved = check(file, ['font-size', '0', text.slice(0, 12)]) as { size: number };
    expect(saved.size).toBeCloseTo(start + 1, 1);
  }

  // One Ctrl+Z undoes only the last change (the size). Undo makes a new revision: the bar must keep
  // the same paragraph, so its controls stay on and show the state of that revision.
  await l.page.keyboard.press('Control+z');
  await expect(size).toHaveValue(String(start), { timeout: 30_000 });
  await expect(bold).toBeEnabled();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(align).toHaveText(/Giữa/);

  // The next undo removes the line spacing (the bar shows no pitch, so nothing visible changes),
  // then the alignment, then the bold.
  await l.page.keyboard.press('Control+z');
  await expect(align).toHaveText(/Giữa/);
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await l.page.keyboard.press('Control+z');
  await expect(align).toHaveText(alignStart, { timeout: 30_000 });
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await l.page.keyboard.press('Control+z');
  await expect(bold).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });

  // Back to the saved state: a clean document closes without asking.
  await l.page.keyboard.press('Control+s');
  await expect(l.page.locator('.doctab__dirty')).toHaveCount(0, { timeout: 120_000 });
});
