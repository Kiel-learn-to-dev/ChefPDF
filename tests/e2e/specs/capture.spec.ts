/**
 * Phone capture (L5 / T8.11): built UI + Electron shell + the REAL core.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 *
 * The phone is simulated by this test process: it fetches the URL shown in the dialog and uploads
 * two JPEG photos to the LAN server. The server is bound to 127.0.0.1 through the E2E-only hook
 * (CHEF_E2E=1 and CHEF_E2E_CAPTURE_BIND=127.0.0.1; ignored in packaged builds).
 *
 * NOT TESTED: the mobile page (apps/desktop/static/capture.html) was not run on a real phone.
 * Only the server side and the desktop dialog are covered here.
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-capture-e2e-'));
const photosScript = path.join(workDir, 'make_photos.py');
const extractScript = path.join(workDir, 'extract.py');
const photoPaths = [path.join(workDir, 'phone-1.jpg'), path.join(workDir, 'phone-2.jpg')];
const outPdf = path.join(workDir, 'chup-dien-thoai.pdf');

const MAKE_PHOTOS = `
import sys
from PIL import Image, ImageDraw

for i, target in enumerate(sys.argv[1:]):
    img = Image.new('RGB', (600, 800), (200, 200, 190))
    d = ImageDraw.Draw(img)
    d.rectangle([60, 80, 540, 720], outline=(20, 20, 20), width=6)
    d.text((100, 120), 'Trang ' + str(i + 1), fill=(0, 0, 0))
    img.save(target, 'JPEG', quality=90)
`;

const EXTRACT = `
import json, sys
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(sys.argv[1])
image = pdf[0].render(scale=0.5).to_pil().convert('RGB')
print(json.dumps({'pages': len(pdf), 'pixel': image.getpixel((10, 10))}))
`;

let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  fs.writeFileSync(photosScript, MAKE_PHOTOS, 'utf8');
  fs.writeFileSync(extractScript, EXTRACT, 'utf8');
  execFileSync('uv', ['run', '--project', coreDir, 'python', '-I', photosScript, ...photoPaths], {
    timeout: 120_000,
  });
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
  fs.rmSync(workDir, { recursive: true, force: true });
});

function pdfInfo(file: string): { pages: number; pixel: number[] } {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', extractScript, file],
    {
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  return JSON.parse(out) as { pages: number; pixel: number[] };
}

test('phone photos arrive in the dialog, and "Xong" makes a two-page PDF', async () => {
  launched = await launchApp({
    env: {
      CHEF_CORE_CMD: realCoreCmd,
      CHEF_E2E: '1',
      CHEF_E2E_CAPTURE_BIND: '127.0.0.1',
    },
  });
  const l = launched;
  const page = l.page;

  // Open "Chụp bằng điện thoại" from the command palette (retried: the window may not have
  // focus right after launch).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('.palette__input')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.locator('.palette__input').fill('Chụp bằng điện thoại');
  await page.getByText('Chụp bằng điện thoại', { exact: true }).last().click();
  const dlg = page.locator('.dlg');
  await expect(dlg).toBeVisible();

  await dlg.locator('.capture__start').click();
  await expect(dlg.locator('.capture__qr svg')).toBeVisible();
  const urlText = (await dlg.locator('.capture__url code').textContent()) ?? '';
  expect(urlText).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f]{32}$/);
  const base = urlText.slice(0, urlText.indexOf('/c/'));
  const token = urlText.slice(urlText.indexOf('/c/') + 3);

  // The mobile page is served only with the right token, with the strict CSP.
  const pageRes = await fetch(urlText);
  expect(pageRes.status).toBe(200);
  expect(pageRes.headers.get('content-security-policy')).toContain("default-src 'none'");
  const wrong = await fetch(`${base}/u/${'b'.repeat(32)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Chef-Index': '0' },
    body: fs.readFileSync(photoPaths[0]!),
  });
  expect(wrong.status).toBe(404);
  expect(await wrong.text()).toBe('Not found');

  // The "phone" uploads two photos.
  for (const [i, file] of photoPaths.entries()) {
    const res = await fetch(`${base}/u/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Chef-Index': String(i) },
      body: fs.readFileSync(file),
    });
    expect(res.status).toBe(200);
  }
  await expect(dlg.locator('.capture__thumb')).toHaveCount(2);
  await expect(dlg.locator('.capture__count')).toHaveText('Đã nhận 2 ảnh');

  // Desktop "Xong": the server stops and the review shows the photos.
  await dlg.locator('.dlg__footer').getByRole('button', { name: 'Xong', exact: true }).click();
  await expect(dlg.locator('.dlg__footer').getByRole('button', { name: 'Tạo PDF' })).toBeEnabled();
  await expect(fetch(`${base}/c/${token}`)).rejects.toThrow();

  // Exercise processing and verify it is saved to the output file.
  const options = dlg.locator('.capture__options');
  const checks = options.getByRole('checkbox');
  await checks.nth(0).click(); // disable auto crop for this pixel check
  await checks.nth(2).click(); // whiten background

  // Save the PDF to the test folder (the save dialog is stubbed in the main process).
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as never;
  }, outPdf);
  await dlg.locator('.dlg__footer').getByRole('button', { name: 'Tạo PDF' }).click();
  await expect(page.locator('.dlg')).toHaveCount(0, { timeout: 60_000 });

  expect(fs.existsSync(outPdf)).toBe(true);
  const info = pdfInfo(outPdf);
  expect(info.pages).toBe(2);
  expect(info.pixel[0]).toBeGreaterThan(220);
});
