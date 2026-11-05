/**
 * 1.2: the About tab and the menu bar. Built UI + Electron + the REAL Python core.
 * - Windows and Linux have no menu bar (Menu.getApplicationMenu() is null); macOS keeps a minimal one;
 * - the About tab shows the version of this build, the core version and the runtime versions, and
 *   it opens over the start screen; clicking the start tab or a document leaves it.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  .version as string;

let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

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
});

test('the menu bar is gone on Windows and Linux', async () => {
  test.skip(process.platform === 'darwin', 'macOS keeps its minimal menu (Edit for the copy keys)');
  launched = await launchUnderTest({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const hasMenu = await launched.app.evaluate(({ Menu }) => Menu.getApplicationMenu() !== null);
  expect(hasMenu).toBe(false);
});

test('the About tab shows this build: version, core, runtime; it leaves when another tab is chosen', async () => {
  launched = await launchUnderTest({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.locator('.doctab--about').click();
  await expect(l.page.locator('.about')).toBeVisible({ timeout: 30_000 });
  await expect(l.page.getByTestId('about-version')).toHaveText(`Phiên bản ${VERSION}`);
  await expect(l.page.getByTestId('about-core')).toContainText(VERSION, { timeout: 30_000 });
  await expect(l.page.getByTestId('about-runtime')).toContainText('Electron');
  await expect(l.page.getByRole('button', { name: 'Mở thư mục nhật ký' })).toBeVisible();
  await expect(l.page.getByRole('button', { name: 'Mở thư mục dữ liệu' })).toBeVisible();

  // The start tab leaves the About tab.
  await l.page.locator('.doctab--home').click();
  await expect(l.page.locator('.about')).toHaveCount(0);
  await expect(l.page.locator('.doctab--about')).toHaveAttribute('aria-selected', 'false');
});
