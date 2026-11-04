/** Large documents in the real app (T11.02). Opt-in: set CHEF_PERF_DIR to a folder that holds
 * pages1000.pdf (1000 pages) and big300.pdf (about 300 MB), made by the scripts in that folder's notes.
 * Without it the test is skipped, because the 300 MB file is too large to make on every run.
 *
 * It records how long each file takes to show its first page, and how long 20 page-downs take,
 * then asserts a generous bound. The numbers go to NOTES.md (T11.02).
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';

const uiBuilt = fs.existsSync(path.join(repoRoot, 'apps', 'ui', 'dist', 'index.html'));
const perfDir = process.env.CHEF_PERF_DIR ?? '';
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');
test.skip(!perfDir, 'set CHEF_PERF_DIR to the folder with pages1000.pdf and big300.pdf');

let launched: Launched | null = null;

test.afterEach(async () => {
  const l = launched;
  launched = null;
  if (!l) return;
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
});

for (const name of ['pages1000.pdf', 'big300.pdf']) {
  test(`${name}: first page shows, and 20 page-downs complete`, async () => {
    test.setTimeout(600_000);
    const file = path.join(perfDir, name);
    expect(fs.existsSync(file)).toBe(true);
    const started = Date.now();
    launched = await launchApp({ args: [file], env: { CHEF_CORE_CMD: realCoreCmd } });
    const page = launched.page;
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 300_000 });
    const firstPageMs = Date.now() - started;

    const scrollStart = Date.now();
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('PageDown');
    await expect(page.locator('.pdfViewer .page canvas').first()).toBeVisible();
    const scrollMs = Date.now() - scrollStart;

    // Printed so the numbers can be copied into NOTES.md.
    console.log(`PERF ${name} firstPageMs=${firstPageMs} scroll20PageDownMs=${scrollMs}`);
    expect(firstPageMs).toBeLessThan(120_000);
    expect(scrollMs).toBeLessThan(60_000);
  });
}
