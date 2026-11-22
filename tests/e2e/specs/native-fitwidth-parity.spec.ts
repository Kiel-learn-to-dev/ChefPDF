/** Electron reference scale measurements for R2.21's fit-width comparison. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const WIDTHS = [800, 1184, 1484] as const;
const HEIGHT = 860;
let fixtureDir = '';
let pdf = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-r2-21-fitwidth-'));
  pdf = path.join(fixtureDir, 'menu_pages.pdf');
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(repoRoot, 'tests/e2e/fixtures/tools5_pages_corpus.py'), fixtureDir],
    { cwd: repoRoot, stdio: 'ignore' },
  );
});

test.afterEach(async () => {
  const current = launched;
  launched = null;
  if (current) {
    const proc = current.app.process();
    await current.app.close();
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});

test.afterAll(() => {
  removeTempDirs();
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('Electron fit-width scale at 800, 1184, and 1484 client pixels', async () => {
  launched = await launchApp({
    args: [pdf, '--force-device-scale-factor=1'],
    env: { CHEF_CORE_CMD: `uv run --project "${path.join(repoRoot, 'core')}" python -m chef_core` },
  });
  const { page } = launched;
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  // Native's current document layout has no right properties panel. Close Electron's default-on
  // panel so the fit-width comparison uses equivalent viewer chrome on both apps.
  const hidePanel = page.getByRole('button', { name: /Hide properties panel|Ẩn bảng thuộc tính/ });
  if (await hidePanel.count()) await hidePanel.click();
  await expect(page.locator('.panel')).toHaveCount(0);

  const measurements: { width: number; zoom: number; pageWidth: number; viewerWidth: number }[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.locator('.zoom__value').click();
    await page.getByRole('menuitem', { name: /Fit width|Vừa chiều rộng/ }).click();
    await page.waitForTimeout(500);
    const measured = await page.evaluate(() => {
      const page = document.querySelector<HTMLElement>('.pdfViewer .page');
      const viewer = document.querySelector<HTMLElement>('.viewer__scroll');
      if (!page || !viewer) throw new Error('PDF page or viewer container is missing');
      const pageWidth = page.getBoundingClientRect().width;
      return {
        pageWidth,
        viewerWidth: viewer.clientWidth,
        zoom: pageWidth / (612 * (96 / 72)),
      };
    });
    expect(measured.zoom).toBeGreaterThan(0);
    measurements.push({ width, ...measured });
  }
  console.log(`R2.21 Electron fit-width: ${JSON.stringify(measurements)}`);
});
