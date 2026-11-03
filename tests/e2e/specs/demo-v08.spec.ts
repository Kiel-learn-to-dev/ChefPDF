/**
 * Demo v0.8 (docs/TASKS.md): "chụp 20 trang sách bằng điện thoại qua QR, tự dò viền, tách trang
 * đôi, làm phẳng, xóa ngón tay, ra PDF đẹp". Built UI + Electron shell + the REAL core. Requires
 * `pnpm --filter @chef/ui build` and `uv`; skipped automatically when the UI is not built.
 *
 * What runs where:
 * - Phone: this test process uploads 20 synthetic photos (18 pages, 2 two-page spreads) to the LAN
 *   server of the capture dialog, the same way capture.spec.ts does.
 * - Desktop: the capture dialog makes the PDF with crop (auto, straighten), split of spreads and
 *   whitening, through the core ops of capturePlan().
 * - Core, one step each (no UI yet, see NOTES): curved page flattening (pageimg.dewarp) and the
 *   finger removal (pageimg.proposeFingerMask, then pageimg.removeFingers with the proposed mask),
 *   run by fixtures/demo_v08_core.py on the real core.
 * Every result is measured again by fixtures/demo_v08_check.py from the rendered pixels.
 *
 * NOT TESTED: a real phone and real book photos (the photos are synthetic, see the fixture).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const coreDir = path.join(repoRoot, 'core');
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;

interface ManifestPhoto {
  file: string;
  pages: number;
  kind: 'single' | 'spread' | 'lowContrast' | 'finger' | 'curved';
  tiltDegrees?: number;
}
interface Manifest {
  photos: ManifestPhoto[];
  outputPages: number;
}
interface PageReport {
  width: number;
  height: number;
  skewDeg: number;
  cornerMean: number;
  skinBorder: number;
  skinShare: number;
  inkShare: number;
}
interface CheckReport {
  pages: number;
  rows: PageReport[];
}
interface StepReport {
  op: string;
  data: Record<string, unknown>;
}

let workDir = '';
let manifest: Manifest;
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

/** Runs core steps on a PDF (demo_v08_core.py); returns the step data. */
function coreSteps(input: string, output: string, steps: unknown[]): StepReport[] {
  const spec = path.join(workDir, `steps-${path.basename(output)}.json`);
  fs.writeFileSync(spec, JSON.stringify({ input, output, steps }), 'utf8');
  const out = JSON.parse(py('demo_v08_core.py', spec)) as { steps: StepReport[] };
  return out.steps;
}

function check(file: string): CheckReport {
  return JSON.parse(py('demo_v08_check.py', file)) as CheckReport;
}

/** 0-based output page index of each photo (a spread gives two pages). */
function firstPageOf(photoIndex: number): number {
  return manifest.photos.slice(0, photoIndex).reduce((sum, p) => sum + p.pages, 0);
}

function uploadPhoto(base: string, token: string, index: number, body: Buffer): Promise<Response> {
  return fetch(`${base}/u/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Chef-Index': String(index) },
    body: new Uint8Array(body),
  });
}

test.beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-demo-v08-'));
  py('demo_v08_photos.py', workDir);
  manifest = JSON.parse(fs.readFileSync(path.join(workDir, 'manifest.json'), 'utf8')) as Manifest;
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

test('20 phone photos become a clean book PDF: crop, split spreads, flatten, remove fingers, whiten', async () => {
  test.setTimeout(420_000);
  const bookPdf = path.join(workDir, 'chu-sach.pdf');
  launched = await launchApp({
    env: {
      CHEF_CORE_CMD: realCoreCmd,
      CHEF_E2E: '1',
      CHEF_E2E_CAPTURE_BIND: '127.0.0.1',
    },
  });
  const page = launched.page;

  // Open "Chụp bằng điện thoại" (retried: the window may not have focus right after launch).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('.palette__input')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.locator('.palette__input').fill('Chụp bằng điện thoại');
  await page.getByText('Chụp bằng điện thoại', { exact: true }).last().click();
  const dlg = page.locator('.dlg');
  await expect(dlg).toBeVisible();

  // Start the session and read the address from the QR dialog.
  await dlg.locator('.capture__start').click();
  await expect(dlg.locator('.capture__qr svg')).toBeVisible();
  const urlText = (await dlg.locator('.capture__url code').textContent()) ?? '';
  expect(urlText).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f]{32}$/);
  const base = urlText.slice(0, urlText.indexOf('/c/'));
  const token = urlText.slice(urlText.indexOf('/c/') + 3);

  // The phone uploads the 20 photos, in the order of the book. The server allows 5 requests a
  // second; a client that gets 429 waits for Retry-After and sends again, as a phone would.
  for (const [i, photo] of manifest.photos.entries()) {
    const body = fs.readFileSync(path.join(workDir, photo.file));
    let res = await uploadPhoto(base, token, i, body);
    for (let tries = 0; res.status === 429 && tries < 20; tries++) {
      await new Promise((r) => setTimeout(r, 1100));
      res = await uploadPhoto(base, token, i, body);
    }
    expect(res.status).toBe(200);
  }
  await expect(dlg.locator('.capture__thumb')).toHaveCount(20, { timeout: 60_000 });
  await expect(dlg.locator('.capture__count')).toHaveText('Đã nhận 20 ảnh');

  // Desktop "Xong", then the processing options: crop (on by default), split spreads, whiten.
  await dlg.locator('.dlg__footer').getByRole('button', { name: 'Xong', exact: true }).click();
  await expect(dlg.locator('.dlg__footer').getByRole('button', { name: 'Tạo PDF' })).toBeEnabled();
  const checks = dlg.locator('.capture__options').getByRole('checkbox');
  await expect(checks.nth(0)).toBeChecked();
  await checks.nth(1).click(); // split two-page spreads
  await checks.nth(2).click(); // whiten the background
  await expect(checks.nth(1)).toBeChecked();
  await expect(checks.nth(2)).toBeChecked();

  // Save to the test folder (the save dialog is stubbed in the main process).
  await launched.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as never;
  }, bookPdf);
  await dlg.locator('.dlg__footer').getByRole('button', { name: 'Tạo PDF' }).click();
  await expect(page.locator('.dlg')).toHaveCount(0, { timeout: 180_000 });
  expect(fs.existsSync(bookPdf)).toBe(true);

  // (1) Pages: 20 photos, two of them spreads -> 22 pages; every photo kept its place in order.
  const book = check(bookPdf);
  expect(book.pages).toBe(manifest.outputPages);
  expect(book.pages).toBe(22);

  const rows = book.rows;
  manifest.photos.forEach((photo, k) => {
    const first = firstPageOf(k);
    for (let n = 0; n < photo.pages; n++) {
      const row = rows[first + n]!;
      const ratio = row.width / row.height;
      if (photo.kind === 'lowContrast') {
        // (2) Low confidence: the crop is not trusted, so the page keeps the full photo size.
        expect(Math.abs(ratio - 0.75)).toBeLessThan(0.005);
        continue;
      }
      // (3) Auto crop: the sheet, not the desk. A4 portrait (0.707) with the core's own padding.
      expect(ratio, `photo ${photo.file} page ${first + n} ratio`).toBeGreaterThan(0.66);
      expect(ratio, `photo ${photo.file} page ${first + n} ratio`).toBeLessThan(0.76);
      // (4) Whitened paper: the corners of a cropped page are paper, not desk or shadow.
      expect(row.cornerMean, `photo ${photo.file} page ${first + n} corners`).toBeGreaterThan(220);
      // (5) Straight text: the photos were tilted by up to 4 degrees; the curved page is handled next.
      if (photo.kind !== 'curved') {
        expect(Math.abs(row.skewDeg), `photo ${photo.file} skew`).toBeLessThanOrEqual(0.5);
      }
    }
  });
  // Each spread became two portrait pages: the second one is portrait too.
  for (const k of manifest.photos.flatMap((p, i) => (p.kind === 'spread' ? [i] : []))) {
    expect(manifest.photos[k]!.pages).toBe(2);
    expect(rows[firstPageOf(k) + 1]!.width).toBeLessThan(rows[firstPageOf(k) + 1]!.height);
  }

  // (6) Flatten the curved page with the real core. The first pass removes most of the curl; a
  // second pass still finds a small residual (a single pass is not a full fit, see NOTES), so
  // it must be well below the first pass.
  const curvedIndex = firstPageOf(manifest.photos.findIndex((p) => p.kind === 'curved'));
  const flatPdf = path.join(workDir, 'chu-sach-lam-phang.pdf');
  const flat = coreSteps(bookPdf, flatPdf, [
    { op: 'pageimg.dewarp', params: { pages: [curvedIndex], minConfidence: 0.35 } },
    { op: 'pageimg.dewarp', params: { pages: [curvedIndex], minConfidence: 0.35 } },
  ]);
  const firstPass = (flat[0]!.data.pages as { status: string; correctionPx?: number }[])[0]!;
  expect(firstPass.status).toBe('done');
  expect(firstPass.correctionPx ?? 0).toBeGreaterThan(3);
  const secondPass = (flat[1]!.data.pages as { status: string; correctionPx?: number }[])[0]!;
  expect(secondPass.status === 'done' ? (secondPass.correctionPx ?? 0) : 0).toBeLessThan(
    (firstPass.correctionPx ?? 0) * 0.5,
  );
  const flatCheck = check(flatPdf);
  expect(flatCheck.pages).toBe(22);
  expect(Math.abs(flatCheck.rows[curvedIndex]!.skewDeg)).toBeLessThanOrEqual(0.5);
  // Nothing else changed: the other pages keep their size.
  expect(flatCheck.rows[0]!.width).toBeCloseTo(rows[0]!.width, 0);

  // (7) Remove a finger that lies on the page: propose the mask, check it, then remove with it.
  // The page is not cropped here: a finger that touches the sheet edge is cut off by the auto crop
  // or leaves a paper-coloured patch on the desk (see NOTES), so the check measures the page as
  // it is. The text under the finger must stay.
  const fingerIn = path.join(workDir, 'finger-page.pdf');
  const fingerOut = path.join(workDir, 'trang-ngon-tay.pdf');
  const finger = coreSteps(fingerIn, fingerOut, [
    { op: 'pageimg.proposeFingerMask', params: { pageIndex: 0 } },
    {
      op: 'pageimg.removeFingers',
      params: { mode: 'mask', maskPng: '$prev.maskPath', pages: [0] },
    },
  ]);
  expect(finger[0]!.data.status).toBe('done');
  expect(finger[0]!.data.coverage as number).toBeGreaterThan(0.001);
  const removed = (finger[1]!.data.pages as { status: string; coverage?: number }[])[0]!;
  expect(removed.status).toBe('done');
  const fingerCheck = check(fingerOut);
  expect(fingerCheck.pages).toBe(1);
  const clean = fingerCheck.rows[0]!;
  expect(clean.skinBorder).toBe(0);
  expect(clean.skinShare).toBeLessThan(0.001);
  expect(clean.inkShare).toBeGreaterThan(0.05);
});
