/* global localStorage */
// Takes UI screenshots against the dev server (mock bridge) in light and dark themes.
// Run: pnpm --filter @chef/ui dev   (in another terminal), then
//      NODE_PATH=$(npm root -g) node scripts/screenshots.mjs [outDir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', 'screenshots'));
const base = process.env.CHEF_UI_URL ?? 'http://localhost:5173/';
mkdirSync(outDir, { recursive: true });

const errors = [];
const browser = await chromium.launch();

async function session(theme) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${theme}] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${theme}] console: ${m.text()}`));
  return { context, page };
}

const settle = (page, ms = 600) => page.waitForTimeout(ms);

for (const theme of ['light', 'dark']) {
  const { context, page } = await session(theme);
  // Start screen with a couple of recent files.
  await page.addInitScript(() => {
    const now = Date.now();
    localStorage.setItem(
      'chef-mock-settings',
      JSON.stringify({
        version: 1,
        language: 'vi',
        theme: 'system',
        defaultSaveDir: null,
        prefs: {},
        recentFiles: [
          {
            path: '/home/an/Tài liệu/Hợp đồng thuê nhà 2026.pdf',
            name: 'Hợp đồng thuê nhà 2026.pdf',
            openedAt: new Date(now - 3600e3).toISOString(),
          },
          {
            path: '/home/an/Tài liệu/Báo cáo quý 3.pdf',
            name: 'Báo cáo quý 3.pdf',
            openedAt: new Date(now - 86400e3).toISOString(),
          },
          {
            path: '/home/an/Downloads/Nghị định 30-2020.pdf',
            name: 'Nghị định 30-2020.pdf',
            openedAt: new Date(now - 4 * 86400e3).toISOString(),
          },
        ],
      }),
    );
  });
  await page.goto(base);
  await page.waitForSelector('.start');
  await settle(page);
  await page.screenshot({ path: join(outDir, `start-${theme}.png`) });

  // Viewer with the demo document.
  await page.goto(`${base}?demo`);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 15000 });
  await page.waitForSelector('.thumbs img', { timeout: 15000 });
  await settle(page, 900);
  await page.screenshot({ path: join(outDir, `viewer-${theme}.png`) });

  // Search (diacritics-insensitive).
  await page.keyboard.press('Control+f');
  await page.fill('.findbar__input', 'nghi dinh');
  await page.waitForSelector('.textLayer .highlight', { timeout: 10000 });
  await settle(page, 700);
  await page.screenshot({ path: join(outDir, `search-${theme}.png`) });
  await page.keyboard.press('Escape');

  // Page organizer.
  await page.click('.ftab:has-text("Trang")');
  await page.waitForSelector('.page-card img', { timeout: 15000 });
  await page.click('.page-card[data-index="1"]');
  await page.click('.page-card[data-index="3"]', { modifiers: ['Shift'] });
  await settle(page, 900);
  await page.screenshot({ path: join(outDir, `pages-${theme}.png`) });

  // Command palette.
  await page.keyboard.press('Control+k');
  await page.fill('.palette__input', 'ky so');
  await settle(page, 300);
  await page.screenshot({ path: join(outDir, `palette-${theme}.png`) });
  await page.keyboard.press('Escape');

  // Split dialog (task dialog pattern).
  await page.keyboard.press('Control+k');
  await page.fill('.palette__input', 'tach file');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.task');
  await settle(page, 500);
  await page.screenshot({ path: join(outDir, `split-${theme}.png`) });
  await context.close();
}

await browser.close();
if (errors.length) {
  console.log('Page errors:\n' + errors.join('\n'));
  process.exitCode = 1;
}
console.log('screenshots in', outDir);
