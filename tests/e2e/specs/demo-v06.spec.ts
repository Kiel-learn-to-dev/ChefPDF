/**
 * Demo of milestone v0.6 end to end: built UI + Electron shell + the REAL Python core.
 * A three-page file gets a logo watermark on every page (made by the core's overlay.watermark).
 * In the app: (1) the watermark manager lists the logo and removes it; (2) a region on page 1 is
 * erased; (3) the CCCD number on page 2 is redacted for good and the check passes. The saved file
 * has no overlay marker on any page, no erased or redacted text, and the other text on every page.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped when the UI has not been built.
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
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'demo-v06');
const FONT = path.join(repoRoot, 'tests', 'corpus', 'fonts', 'BeVietnamPro-Regular.ttf');
const CCCD = '012345678901';
const ERASED = 'dòng này sẽ được tẩy đi';
const PAGE_WIDTH_PT = 595.27; // A4
// Page 1, first line (points, top-left origin): the erase cut goes over it and nothing else.
const ERASE_FROM = { x: 60, y: 128 };
const ERASE_TO = { x: 330, y: 150 };

let corpus = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Runs the check script with the core's Python environment and returns its JSON output. */
function check(file: string, mode: string, needle?: string): Record<string, unknown> {
  const args = [path.join(corpus, 'redact_check.py'), file, mode, ...(needle ? [needle] : [])];
  const out = execFileSync('uv', ['run', '--project', coreDir, 'python', '-I', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
}

test.beforeAll(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-demo-v06-'));
  execFileSync(
    'uv',
    [
      'run',
      '--project',
      'core',
      'python',
      path.join(fixturesDir, 'demo_v06_corpus.py'),
      corpus,
      FONT,
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  fs.copyFileSync(path.join(fixturesDir, 'redact_check.py'), path.join(corpus, 'redact_check.py'));
  fs.mkdirSync(shotsDir, { recursive: true });
});

test.afterEach(async () => {
  const l = launched;
  launched = null;
  if (!l) return;
  // A dirty document makes the UI cancel the close to ask the user; never hang the suite on it.
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
  fs.rmSync(corpus, { recursive: true, force: true });
});

const open = async (file: string): Promise<Launched> => {
  launched = await launchApp({
    args: [path.join(corpus, file)],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  await launched.page.setViewportSize({ width: 1280, height: 800 });
  return launched;
};

const waitViewer = (l: Launched) =>
  l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });

const waitJobs = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.status__job.is-running'), null, {
    timeout: 30_000,
  });

const waitSaved = (l: Launched) =>
  l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 30_000,
  });

/** Runs a command from the palette (Ctrl+K): its title typed, the first match picked. */
async function runCommand(l: Launched, title: string): Promise<void> {
  await l.page.keyboard.press('Control+k');
  await l.page.locator('.palette__input').fill(title);
  await l.page.locator('[role="option"]').first().click();
}

/** Makes the watermarked file: the core stamps the logo on every page, then the session is saved. */
async function stampLogo(src: string, logo: string, out: string): Promise<void> {
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.evaluate(
    async ({ src: source, logoPath, target }) => {
      const outcome = new Map<string, { name: string; detail: string }>();
      window.chef.onEvent((e) => {
        const ev = e as unknown as {
          type: string;
          name?: string;
          payload?: { jobId?: string; error?: { message?: string } };
        };
        const ends = ['job.finished', 'job.failed', 'job.cancelled'];
        if (ev.type === 'rpc' && ev.payload?.jobId && ev.name && ends.includes(ev.name)) {
          outcome.set(ev.payload.jobId, {
            name: ev.name,
            detail: JSON.stringify(ev.payload).slice(0, 400),
          });
        }
      });
      const { state } = await window.chef.rpc('session.open', { path: source });
      const sessionId = state.sessionId;
      const { jobId } = await window.chef.rpc('ops.run', {
        sessionId,
        opId: 'overlay.watermark',
        params: { path: logoPath, width: 150 },
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          const got = outcome.get(jobId);
          if (!got) return;
          clearInterval(timer);
          if (got.name === 'job.finished') resolve();
          else reject(new Error(`overlay.watermark failed: ${got.detail}`));
        }, 50);
      });
      await window.chef.rpc('session.save', { sessionId, path: target });
      await window.chef.rpc('session.close', { sessionId });
    },
    { src, logoPath: logo, target: out },
  );
  await l.app.close();
  launched = null;
}

test('demo v0.6: the logo on every page is removed, a region is erased, the CCCD is redacted, and nothing is left to copy', async () => {
  const src = path.join(corpus, 'demo.pdf');
  const wm = path.join(corpus, 'demo-logo.pdf');
  await stampLogo(src, path.join(corpus, 'logo.png'), wm);
  expect(check(wm, 'pages', 'ChefOverlay')).toEqual({ counts: [1, 1, 1] });

  const l = await open('demo-logo.pdf');
  await waitViewer(l);

  // 1. the logo: listed with confidence 100% and removed from all three pages
  await runCommand(l, 'Gỡ watermark');
  await expect(l.page.locator('.dlg__title')).toHaveText('Gỡ watermark');
  await expect(l.page.getByTestId('wm-candidate').first()).toBeVisible({ timeout: 30_000 });
  await expect(l.page.locator('[data-testid="wm-candidate"] [role="img"]').first()).toHaveAttribute(
    'aria-label',
    'Độ tin cậy 100%',
  );
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: /Gỡ \d+ đã chọn/ })
    .click();
  await expect(l.page.locator('.rd-verified')).toContainText('Đã gỡ', { timeout: 60_000 });
  await l.page.keyboard.press('Escape');
  await waitJobs(l);

  // 2. a region on page 1: the erase cut goes over the first line
  await l.page.click('.ftab >> text=Chỉnh sửa');
  await l.page.locator('.toolbar__btn[aria-label="Thêm"]').click();
  await l.page.getByRole('menuitem', { name: 'Tẩy vùng' }).click();
  await l.page.waitForSelector('[data-testid="erase-layer"]');
  const box = await l.page
    .locator('.pdfViewer .page[data-page-number="1"] canvas')
    .first()
    .boundingBox();
  if (!box) throw new Error('page 1 has no box');
  const scale = box.width / PAGE_WIDTH_PT;
  const from = { x: box.x + ERASE_FROM.x * scale, y: box.y + ERASE_FROM.y * scale };
  const to = { x: box.x + ERASE_TO.x * scale, y: box.y + ERASE_TO.y * scale };
  await l.page.mouse.move(from.x, from.y);
  await l.page.mouse.down();
  await l.page.mouse.move(to.x, to.y, { steps: 8 });
  await l.page.mouse.up();
  await expect(l.page.locator('[data-testid="erase-bar"]')).toBeVisible();
  await l.page.locator('[data-testid="erase-bar"] button', { hasText: 'Áp dụng' }).click();
  await waitJobs(l);

  // 3. the CCCD number on page 2: redacted for good, the check passes
  await runCommand(l, 'Che thông tin mật');
  await expect(l.page.locator('.dlg__title')).toHaveText('Che thông tin mật');
  await l.page.locator('.dlg__body').getByRole('button', { name: 'Tìm', exact: true }).click();
  await expect(l.page.locator('.dlg__body')).toContainText(CCCD, { timeout: 30_000 });
  await l.page
    .locator('.dlg__footer')
    .getByRole('button', { name: /Che vĩnh viễn/ })
    .click();
  await l.page.getByRole('button', { name: 'Che và xóa vĩnh viễn', exact: true }).click();
  await expect(l.page.locator('.rd-verified')).toContainText(
    '✓ Đã kiểm chứng: không còn chữ bên dưới',
    { timeout: 60_000 },
  );
  await l.page.screenshot({ path: path.join(shotsDir, 'demo-verified.png') });

  await l.page.keyboard.press('Escape');
  await waitJobs(l);
  await l.page.keyboard.press('Control+s');
  await waitSaved(l);

  // The saved file (Ctrl+S writes the opened file): no overlay left on any page, the erased and
  // the redacted text are gone from the text layer, and the other text is on its page.
  expect(check(wm, 'pages', 'ChefOverlay')).toEqual({ counts: [0, 0, 0] });
  const { text } = check(wm, 'text') as { text: string };
  expect(text).not.toContain(ERASED);
  expect(text).not.toContain(CCCD);
  expect(text).toContain('Trang một: nội dung giữ lại.');
  expect(text).toContain('Trang hai: nội dung khác giữ lại.');
  expect(text).toContain('Trang ba: nội dung cuối cùng giữ lại.');
});
