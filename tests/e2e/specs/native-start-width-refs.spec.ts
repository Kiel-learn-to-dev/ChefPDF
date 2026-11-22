/**
 * Electron reference captures for the Rust Start screen at the R2.16 audit widths.
 * Run with CAPTURE_NATIVE_START_REFS=1; set NATIVE_START_REFS_OUT to an external directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot, removeTempDirs } from '../fixtures/app';

const WIDTHS = [800, 1184, 1484] as const;
const HEIGHT = 860;
const THEMES = ['light', 'dark'] as const;
const OUT_DIR =
  process.env.NATIVE_START_REFS_OUT ??
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'ChefPDF', 'R2.16-start');
const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));

test.skip(
  !uiBuilt || process.env.CAPTURE_NATIVE_START_REFS !== '1',
  'Set CAPTURE_NATIVE_START_REFS=1 after the Electron UI is built to capture Start references.',
);
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const fullOut = path.resolve(OUT_DIR);
  const temp = path.resolve(os.tmpdir());
  const inside = (file: string, root: string) =>
    file.toLowerCase() === root.toLowerCase() ||
    file.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`);
  if (inside(fullOut, repoRoot) || inside(fullOut, temp)) {
    throw new Error(`NATIVE_START_REFS_OUT must be outside the repository and temp directory: ${fullOut}`);
  }
  fs.mkdirSync(fullOut, { recursive: true });
  console.log(`R2.16 Electron references: ${fullOut}`);
});

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`Start ${width}px ${theme} at DPR 1.75`, async () => {
      const launched = await launchApp();
      try {
        const { page } = launched;
        await page.locator('.start__hero').waitFor({ timeout: 30_000 });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: HEIGHT,
          deviceScaleFactor: 1.75,
          mobile: false,
        });
        await page.emulateMedia({ colorScheme: theme });
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
          (document.activeElement as HTMLElement | null)?.blur();
          return document.fonts.ready;
        }, theme);
        await page.mouse.move(0, 0);
        await page.waitForTimeout(200);
        const metrics = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio,
        }));
        expect(metrics).toEqual({ width, height: HEIGHT, dpr: 1.75 });
        const target = path.join(OUT_DIR, `electron_start_${theme}_w${width}.png`);
        await page.screenshot({ path: target });
        const png = fs.readFileSync(target);
        expect(png.readUInt32BE(16)).toBe(Math.round(width * 1.75));
        expect(png.readUInt32BE(20)).toBe(Math.round(HEIGHT * 1.75));
        console.log(`CAPTURED ${theme} ${width}x${HEIGHT} CSS @ DPR ${metrics.dpr}: ${target}`);
      } finally {
        const proc = launched.app.process();
        await launched.app.close();
        if (proc.exitCode === null) proc.kill('SIGKILL');
        removeTempDirs();
      }
    });
  }
}
