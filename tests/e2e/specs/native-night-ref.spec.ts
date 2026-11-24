/**
 * Ảnh tham chiếu đọc ban đêm của bản Electron 1.3.0 cho R2.28 (TASKS_RUST).
 *
 * Mở PDF sáu mảng màu (tạo ngoài repo), chụp trang 1 ở chế độ ngày và đêm ở DPR của Windows (không ép DPR).
 * Ảnh PNG ghi NGOÀI repo (R228_OUT, mặc định trong LOCALAPPDATA/ChefPDF/visual-refs/r228). Không ghi vào repo.
 *
 * Chạy (cần UI và bản desktop đã build từ mã hiện tại):
 *   R228_SWATCH_PDF=<đường dẫn swatches.pdf> pnpm --filter @chef/e2e exec playwright test native-night-ref
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot, type Launched } from '../fixtures/app';
import { DIST_INDEX, stubNativeDialogs } from '../fixtures/uiAudit';

const OUT_DIR =
  process.env.R228_OUT ??
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'ChefPDF', 'visual-refs', 'r228')
    : path.join(os.homedir(), '.local', 'share', 'chef-pdf', 'visual-refs', 'r228'));
const SWATCH_PDF =
  process.env.R228_SWATCH_PDF ?? path.join(OUT_DIR, 'swatches.pdf');
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const uiBuilt = fs.existsSync(DIST_INDEX);

async function closeApp(l: Launched): Promise<void> {
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');
test.skip(
  !fs.existsSync(path.resolve(SWATCH_PDF)),
  'set R228_SWATCH_PDF to the swatches PDF to capture R2.28 night references',
);

test('ảnh tham chiếu đọc ban đêm (ngày và đêm) của Electron', async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const source = path.resolve(SWATCH_PDF);
  expect(fs.existsSync(source), `thiếu PDF mẫu: ${source}`).toBe(true);
  const l = await launchApp({
    args: [source],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  try {
    await stubNativeDialogs(l.app);
    await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
    const canvas = l.page.locator('.pdfViewer .page canvas').first();
    await canvas.waitFor({ state: 'visible', timeout: 30_000 });
    const toggle = l.page.getByRole('button', { name: 'Chế độ đọc ban đêm' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(l.page.locator('.pdfViewer .page').first()).toHaveCSS('filter', 'none');
    await canvas.screenshot({ path: path.join(OUT_DIR, 'electron_r228_day.png') });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(l.page.locator('.pdfViewer .page').first()).toHaveCSS(
      'filter',
      'invert(1) hue-rotate(180deg)',
    );
    await canvas.screenshot({ path: path.join(OUT_DIR, 'electron_r228_night.png') });
  } finally {
    await closeApp(l);
  }
});
