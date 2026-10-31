/* global document */
// Interaction smoke test against the dev server with the mock bridge.
// Run: pnpm --filter @chef/ui dev, then NODE_PATH=$(npm root -g) node scripts/smoke.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.env.CHEF_UI_URL ?? 'http://localhost:5173/';
const errors = [];
const log = (...a) => console.log('•', ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  log('ok', msg);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('PAGE ERROR', e.message);
});
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const pageCount = () => page.locator('.page-card').count();
const waitJobs = () =>
  page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 10000,
  });

await page.goto(`${base}?demo`);
await page.waitForSelector('.pdfViewer .page canvas');

// Search: đ handling
await page.keyboard.press('Control+f');
await page.fill('.findbar__input', 'dong dau');
await page.waitForSelector('.textLayer .highlight');
assert(
  (await page.textContent('.findbar__count')).includes('/'),
  'diacritics-insensitive search finds "đóng dấu"',
);
await page.keyboard.press('Escape');

// Organizer
await page.click('.ftab >> text=Trang');
await page.waitForSelector('.page-card img');
assert((await pageCount()) === 9, '9 pages');
await page.click('.page-card[data-index="0"]');
await page.keyboard.press('Delete');
await waitJobs();
await page.waitForFunction(() => document.querySelectorAll('.page-card').length === 8);
assert(true, 'Delete removes a page');
assert(await page.isVisible('.doctab__dirty'), 'tab shows dirty marker');
await page.keyboard.press('Control+z');
await page.waitForFunction(() => document.querySelectorAll('.page-card').length === 9);
assert(true, 'Ctrl+Z restores the page');
await page.keyboard.press('Control+y');
await page.waitForFunction(() => document.querySelectorAll('.page-card').length === 8);
assert(true, 'Ctrl+Y redoes');
await page.keyboard.press('Control+z');
await page.waitForFunction(() => document.querySelectorAll('.page-card').length === 9);

// Select range + rotate via toolbar
await page.click('.page-card[data-index="1"]');
await page.click('.page-card[data-index="2"]', { modifiers: ['Shift'] });
assert((await page.locator('.page-card.is-selected').count()) === 2, 'shift-click selects a range');
await page.click('.toolbar button[aria-label="Xoay phải"], .toolbar button:has-text("Xoay phải")');
await waitJobs();
await page.waitForSelector('.page-card__rot');
assert((await page.locator('.page-card__rot').count()) === 2, 'rotate marks 2 pages as 90°');

// Duplicate
await page.keyboard.press('Control+d');
await waitJobs();
await page.waitForFunction(() => document.querySelectorAll('.page-card').length === 11);
assert(true, 'Ctrl+D duplicates selected pages');

// Drag page 1 after page 4
const src = await page.locator('.page-card[data-index="0"]').boundingBox();
const dst = await page.locator('.page-card[data-index="3"]').boundingBox();
await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
await page.mouse.down();
await page.mouse.move(src.x + src.width / 2 + 20, src.y + src.height / 2, { steps: 4 });
await page.mouse.move(dst.x + dst.width / 2 + 10, dst.y + dst.height / 2, { steps: 12 });
await page.mouse.up();
await waitJobs();
await page.waitForTimeout(400);
const jobsTitles = await page.evaluate(() => document.querySelector('.status__job')?.textContent);
log('jobs indicator:', jobsTitles);
await page.click('.status__job');
await page.waitForSelector('.jobs-panel');
const jobText = await page.textContent('.jobs-panel');
assert(jobText.includes('Đổi thứ tự trang'), 'drag-and-drop ran page.reorder (job panel)');
await page.keyboard.press('Escape');

// Insert blank via panel
await page.click('.panel button:has-text("Chèn trang trắng")');
await waitJobs();
await page.waitForFunction(() => document.querySelectorAll('.page-card').length === 12);
assert(true, 'insert blank page');

// Properties dialog & print dialog open
await page.click('.ftab >> text=Xem');
await page.waitForSelector('.pdfViewer .page canvas');
await page.click('button:has-text("Xem đầy đủ thuộc tính")');
await page.waitForSelector('.props');
assert((await page.textContent('.props')).includes('1.'), 'properties dialog shows PDF version');
await page.keyboard.press('Escape');
await page.keyboard.press('Control+p');
await page.waitForSelector('text=Trang cần in');
assert(true, 'print dialog opens');
await page.keyboard.press('Escape');

// View modes
await page.click('button[aria-label="Chế độ xem"]');
await page.click('[role=menuitem]:has-text("Hai trang")');
await page.waitForSelector('.pdfViewer .spread');
assert(true, 'two-page spread mode');

// Save as (mock writes into /mock/out)
await page.keyboard.press('Control+Shift+S');
await page.waitForSelector('.toast:has-text("Đã lưu")');
assert(!(await page.isVisible('.doctab__dirty')), 'saved document is clean');

// Split (task dialog) with default ranges -> 2 outputs
await page.keyboard.press('Control+k');
await page.fill('.palette__input', 'tach file');
await page.keyboard.press('Enter');
await page.waitForSelector('.task');
await page.fill('#split-dir', '/mock/out');
await page.click('.dlg__footer button:has-text("Tách")');
await page.waitForSelector('text=Đã tách xong');
assert((await page.locator('.split__outputs li').count()) === 2, 'split wrote 2 files');
await page.keyboard.press('Escape');

// Merge: current file + another picked file
await page.keyboard.press('Control+k');
await page.fill('.palette__input', 'ghep');
await page.keyboard.press('Enter');
await page.waitForSelector('.merge__row');
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('.merge__head button'),
]);
await chooser.setFiles(new URL('../dev/sample.pdf', import.meta.url).pathname);
await page.waitForFunction(
  () =>
    document.querySelectorAll('.merge__row').length === 2 &&
    !document.querySelector('.merge__row .spinner'),
);
await page.click('.dlg__footer button:has-text("Ghép")');
await page.waitForSelector('text=Đã ghép xong');
await page.click('.dlg__footer button:has-text("Mở file kết quả")');
await page.waitForFunction(() => document.querySelectorAll('.doctab-wrap').length === 3);
assert(true, 'merge result opens in a new tab');

// Settings: switch to English
await page.keyboard.press('Control+,');
await page.click('#set-lang');
await page.click('[role=option]:has-text("English")');
await page.waitForSelector('.ftab:has-text("View")');
assert(true, 'language switches to English');
await page.click('[role=option], body', { position: { x: 5, y: 5 } }).catch(() => undefined);

await browser.close();
if (errors.length) {
  console.log('Page errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} else console.log('smoke: all good');
