/**
 * Start screen tiles for stamp and compress: they are enabled (no "Sắp có" badge) and open the
 * matching dialog after asking for a PDF. Built UI + Electron shell + the REAL Python core.
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

let corpus = '';
let source = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-start-tiles-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'tools5_pages_corpus.py'),
      corpus,
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  source = path.join(corpus, 'menu_pages.pdf');
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

async function launchStart(): Promise<Launched> {
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await expect(l.page.getByRole('heading', { name: 'Quy trình mẫu' })).toBeVisible({
    timeout: 30_000,
  });
  return l;
}

test('stamp and compress tiles are enabled and carry no coming-soon badge', async () => {
  const l = await launchStart();
  const tiles = l.page.locator('section[aria-labelledby="start-tasks"]');
  for (const name of [/^Đóng dấu/, /^Nén/]) {
    const tile = tiles.getByRole('button', { name });
    await expect(tile).toBeEnabled();
    await expect(tile).not.toContainText('Sắp có');
  }
  await expect(tiles).not.toContainText('Sắp có');
});

for (const [tile, title] of [
  [/^Đóng dấu/, 'Con dấu'],
  [/^Nén/, 'Nén PDF'],
] as const) {
  test(`the ${title} tile asks for a PDF, opens it and shows the dialog`, async () => {
    const l = await launchStart();
    await l.app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never;
    }, source);
    await l.page
      .locator('section[aria-labelledby="start-tasks"]')
      .getByRole('button', { name: tile })
      .click();
    await expect(l.page.locator('.dlg__title')).toHaveText(title, { timeout: 30_000 });
  });
}
