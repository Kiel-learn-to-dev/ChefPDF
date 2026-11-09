/**
 * Ảnh tham chiếu của bản Electron 1.3.0 cho bộ thử hình họa native (TASKS_RUST R1.21).
 *
 * Ba màn hình (Start, viewer, một hộp thoại) × hai theme × DPR 1 và 1.75. Ảnh PNG ghi NGOÀI repo
 * (NATIVE_REFS_OUT, mặc định thư mục tạm của hệ điều hành); chỉ manifest có SHA-256, kích thước
 * và DPR đo được nằm trong repo: tests/visual/native-refs/manifest.json.
 *
 * Chạy (cần UI và bản desktop đã build từ mã hiện tại):
 *   pnpm --filter @chef/ui build && (cd apps/desktop && pnpm build)
 *   pnpm --filter @chef/e2e exec playwright test native-refs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, repoRoot, type Launched } from '../fixtures/app';
import {
  DIST_INDEX,
  VIEWPORT,
  gitCommit,
  hasHook,
  openScreen,
  resetScreen,
  stubNativeDialogs,
  type Screen,
} from '../fixtures/uiAudit';

// DPR 1 ép bằng cờ và cỡ viewport cố định. DPR 1,75 lấy theo tỉ lệ hiển thị của Windows (AppliedDPI 168).
// Không gọi setViewportSize ở DPR khác 1: Playwright đặt lại device scale factor về 1.
const DPRS = [1, 1.75] as const;
const THEMES = ['light', 'dark'] as const;
const OUT_DIR = process.env.NATIVE_REFS_OUT ?? path.join(os.tmpdir(), 'chef-native-refs');
const MANIFEST_FILE = path.join(repoRoot, 'tests', 'visual', 'native-refs', 'manifest.json');
const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const uiBuilt = fs.existsSync(DIST_INDEX);

const SCREENS: { key: string; screen: Screen }[] = [
  { key: 'start', screen: { name: 'start', kind: 'start' } },
  { key: 'view', screen: { name: 'main:view', kind: 'main', tab: 'view' } },
  { key: 'dialog-merge', screen: { name: 'dialog:merge', kind: 'dialog', dialog: 'merge' } },
];

interface RefFile {
  file: string;
  screen: string;
  theme: string;
  dpr: number;
  devicePixelRatio: number;
  /** Kích thước khung nhìn CSS (innerWidth × innerHeight) lúc chụp. */
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  sha256: string;
}

const records: RefFile[] = [];
/** DPR 1 ép bằng cờ, để không phụ thuộc tỉ lệ hiển thị của máy. */
const scaleArgs = (dpr: number): string[] => (dpr === 1 ? ['--force-device-scale-factor=1'] : []);
let source = '';
let corpus = '';

/** Kích thước PNG đọc từ IHDR (byte 16 đến 23). */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Tắt hoạt ảnh và đổi theme như bộ đo giao diện (ui-audit `prepare`), nhưng theo tham số. */
async function setTheme(page: Page, theme: string): Promise<void> {
  await page.evaluate((t) => {
    if (!document.getElementById('native-refs-style')) {
      const style = document.createElement('style');
      style.id = 'native-refs-style';
      style.textContent =
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.append(style);
    }
    document.documentElement.dataset.theme = t;
    (document.activeElement as HTMLElement | null)?.blur();
  }, theme);
  await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

async function shoot(page: Page, dpr: number, theme: string, key: string, screen: string): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = `${key}_${theme}_dpr${String(dpr).replace('.', '_')}.png`;
  const full = path.join(OUT_DIR, file);
  await page.screenshot({ path: full });
  const buf = fs.readFileSync(full);
  const { width, height } = pngSize(buf);
  const css = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  records.push({
    file,
    screen,
    theme,
    dpr,
    devicePixelRatio: css.dpr,
    cssWidth: css.w,
    cssHeight: css.h,
    width,
    height,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  });
}

async function closeApp(l: Launched): Promise<void> {
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  // Thư mục cố định cho PDF mẫu: đường dẫn hiện trong hộp "Lưu vào thư mục" nếu đổi mỗi lần thì ảnh lệch.
  corpus = path.join(OUT_DIR, 'corpus');
  fs.rmSync(corpus, { recursive: true, force: true });
  fs.mkdirSync(corpus, { recursive: true });
  execFileSync(
    'uv',
    ['run', '--project', 'core', 'python', path.join(fixturesDir, 'tools5_pages_corpus.py'), corpus],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  source = path.join(corpus, 'menu_pages.pdf');
});

test.afterAll(() => {
  fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
  fs.writeFileSync(
    MANIFEST_FILE,
    JSON.stringify(
      {
        commit: gitCommit(),
        app: 'Chef PDF Electron 1.3.0 (apps/desktop, apps/ui)',
        viewport: VIEWPORT,
        themes: THEMES,
        dprs: DPRS,
        generatedAt: new Date().toISOString(),
        files: records,
      },
      null,
      2,
    ) + '\n',
  );
});

for (const dpr of DPRS) {
  test(`ảnh tham chiếu ở DPR ${dpr}`, async () => {
    // Màn hình Start: mở app không có file.
    const start = await launchApp({
      args: scaleArgs(dpr),
      env: { CHEF_CORE_CMD: realCoreCmd },
    });
    try {
      await stubNativeDialogs(start.app);
      if (dpr === 1) await start.page.setViewportSize(VIEWPORT);
      await start.page
        .getByRole('heading', { name: 'Quy trình mẫu' })
        .waitFor({ state: 'visible', timeout: 30_000 });
      for (const theme of THEMES) {
        await setTheme(start.page, theme);
        await shoot(start.page, dpr, theme, 'start', 'start');
      }
    } finally {
      await closeApp(start);
    }

    // Viewer và hộp thoại: mở PDF mẫu.
    const doc = await launchApp({
      args: [source, ...scaleArgs(dpr)],
      env: { CHEF_CORE_CMD: realCoreCmd },
    });
    try {
      await stubNativeDialogs(doc.app);
      if (dpr === 1) await doc.page.setViewportSize(VIEWPORT);
      await doc.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
      expect(await hasHook(doc.page)).toBe(true);
      for (const theme of THEMES) {
        await resetScreen(doc.page);
        await setTheme(doc.page, theme);
        await shoot(doc.page, dpr, theme, 'view', 'main:view');
        const dialog = SCREENS.find((s) => s.key === 'dialog-merge')!.screen;
        expect(await openScreen(doc.page, dialog, source)).toBe(true);
        await shoot(doc.page, dpr, theme, 'dialog-merge', dialog.name);
      }
    } finally {
      await closeApp(doc);
    }

    // Kiểm: DPR thật của trang khớp DPR yêu cầu, và kích thước ảnh bằng khung CSS × DPR.
    for (const r of records.filter((x) => x.dpr === dpr)) {
      expect(Math.abs(r.devicePixelRatio - dpr)).toBeLessThan(0.01);
      expect(Math.abs(r.width - r.cssWidth * dpr)).toBeLessThanOrEqual(2);
      expect(Math.abs(r.height - r.cssHeight * dpr)).toBeLessThanOrEqual(2);
    }
  });
}
