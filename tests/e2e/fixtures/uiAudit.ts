/**
 * Hàm dùng chung cho bộ đo giao diện (ui-audit.spec.ts, kế hoạch docs/UI_AUDIT.md mục 2):
 * danh sách màn hình (đọc từ ui.ts lúc chạy), mở từng màn hình qua window.__chefUi, chuẩn bị
 * trước khi chụp, ảnh chụp và báo cáo JSON. Hàm trong page.evaluate phải tự chứa (không import).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { repoRoot } from './app';
import type { AuditGroup } from './uiAuditRules';

export const UI_DIR = path.join(repoRoot, 'apps', 'ui');
export const SRC_DIR = path.join(UI_DIR, 'src');
export const DIST_INDEX = path.join(UI_DIR, 'dist', 'index.html');
const UI_STATE_FILE = path.join(SRC_DIR, 'app', 'state', 'ui.ts');
/**
 * Chế độ phụ (không thay baseline 1280 sáng):
 * - UI_AUDIT_VIEWPORT=960x640: cỡ cửa sổ hẹp, kiểm tràn chân hộp và xuống dòng;
 * - UI_AUDIT_THEME=dark: chụp giao diện tối để xem bằng mắt (không so baseline).
 * Mỗi chế độ ghi ra thư mục riêng để không ghi đè báo cáo chính.
 */
const vpEnv = process.env.UI_AUDIT_VIEWPORT ?? '';
const vpMatch = /^(\d+)x(\d+)$/.exec(vpEnv);
export const VIEWPORT = vpMatch
  ? { width: Number(vpMatch[1]), height: Number(vpMatch[2]) }
  : { width: 1280, height: 820 };
export const THEME: 'light' | 'dark' = process.env.UI_AUDIT_THEME === 'dark' ? 'dark' : 'light';
export const THEME_NAME = THEME;
const suffix = [vpMatch ? vpEnv : '', THEME === 'dark' ? 'dark' : ''].filter(Boolean).join('-');
export const OUT_DIR = path.join(
  repoRoot,
  'tests',
  'e2e',
  suffix ? `ui-audit-out-${suffix}` : 'ui-audit-out',
);
export const SHOT_DIR = path.join(OUT_DIR, 'shots');
export const REPORT_FILE = path.join(OUT_DIR, 'report.json');

// ---------- Danh sách màn hình (đọc từ ui.ts, không ghi tay) ----------

function quotedNames(block: string): string[] {
  return [...block.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]!);
}

export function readUiSource(file = UI_STATE_FILE): string {
  return fs.readFileSync(file, 'utf8');
}

/** Mọi DialogId trong `export type DialogId = ...;`. */
export function readDialogIds(src = readUiSource()): string[] {
  const m = /export type DialogId\s*=([\s\S]*?);/.exec(src);
  if (!m) throw new Error('Không đọc được `export type DialogId` trong ui.ts');
  return quotedNames(m[1]!);
}

export function readFunctionTabs(src = readUiSource()): string[] {
  const m = /export const FUNCTION_TABS = \[([\s\S]*?)\] as const/.exec(src);
  if (!m) throw new Error('Không đọc được FUNCTION_TABS trong ui.ts');
  return quotedNames(m[1]!);
}

export function readSidebarTabs(src = readUiSource()): string[] {
  const m = /export type SidebarTab\s*=([\s\S]*?);/.exec(src);
  if (!m) throw new Error('Không đọc được `export type SidebarTab` trong ui.ts');
  return quotedNames(m[1]!);
}

export interface Screen {
  name: string;
  kind: 'start' | 'main' | 'overlay' | 'dialog' | 'edit' | 'about';
  tab?: string;
  sidebarTab?: string;
  overlay?: 'palette' | 'jobPanel' | 'findbar';
  dialog?: string;
}

/** start; main:<tab> (8 tab); main:view/sidebar:<x> (5 tab bên); lớp phủ; chỉnh sửa; mọi DialogId. */
export function buildScreens(src = readUiSource()): Screen[] {
  const screens: Screen[] = [{ name: 'start', kind: 'start' }];
  for (const tab of readFunctionTabs(src)) {
    screens.push({ name: `main:${tab}`, kind: 'main', tab });
  }
  for (const sidebarTab of readSidebarTabs(src)) {
    screens.push({
      name: `main:view/sidebar:${sidebarTab}`,
      kind: 'main',
      tab: 'view',
      sidebarTab,
    });
  }
  for (const overlay of ['palette', 'jobPanel', 'findbar'] as const) {
    screens.push({ name: `overlay:${overlay}`, kind: 'overlay', overlay });
  }
  // Chế độ Chỉnh sửa: không có hook riêng, spec bật chế độ bằng thao tác trên giao diện.
  screens.push({ name: 'edit:textEdit', kind: 'edit' }, { name: 'edit:paragraph', kind: 'edit' });
  // The About tab (1.2) opens over the start screen.
  screens.push({ name: 'about', kind: 'about' });
  for (const dialog of readDialogIds(src)) {
    screens.push({ name: `dialog:${dialog}`, kind: 'dialog', dialog });
  }
  return screens;
}

/** Dữ liệu cho hộp thoại cần tham số; các hộp thoại khác mở không có dữ liệu. */
export function dialogData(id: string, source: string): unknown {
  switch (id) {
    case 'capture':
      return { purpose: 'book' };
    case 'merge':
      return [source, source];
    case 'repair':
      return { path: source, message: 'x' };
    case 'stamp':
    case 'pdfToImages':
      return { pages: [1] };
    case 'cropReview':
      return { page: 0 };
    case 'recovery':
      return [];
    default:
      return undefined;
  }
}

// ---------- Thao tác trên trang ----------

type UiHookWindow = {
  __chefUi?: {
    getState(): {
      closeDialog(): void;
      openDialog(id: string, data?: unknown): void;
      openFind(): void;
      set(patch: Record<string, unknown>): void;
    };
  };
};

/** Trang đã có hook test chưa (dist cũ thì không có). */
export async function hasHook(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as unknown as UiHookWindow).__chefUi));
}

/** Đóng hộp thoại và lớp phủ trước khi mở màn hình kế tiếp. */
export async function resetScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hook = (window as unknown as UiHookWindow).__chefUi;
    if (!hook) throw new Error('missing-hook: dist thiếu window.__chefUi, hãy build lại UI');
    const s = hook.getState();
    s.closeDialog();
    s.set({ paletteOpen: false, jobPanelOpen: false, findOpen: false });
  });
  // Radix giữ hộp thoại đang đóng vài trăm ms; chờ nó biến khỏi DOM để không đo nhầm.
  await page
    .waitForFunction(() => !document.querySelector('.dlg'), undefined, { timeout: 3_000 })
    .catch(() => undefined);
}

/** Mở một màn hình (không đo, không chụp). Trả về false nếu hộp thoại không hiện. */
export async function openScreen(page: Page, screen: Screen, source: string): Promise<boolean> {
  await page.evaluate(
    ({ s, data }) => {
      const hook = (window as unknown as UiHookWindow).__chefUi;
      if (!hook) throw new Error('missing-hook');
      const st = hook.getState();
      if (s.kind === 'main') {
        st.set({ functionTab: s.tab, sidebarTab: s.sidebarTab ?? 'thumbnails' });
      } else if (s.kind === 'overlay') {
        if (s.overlay === 'palette') st.set({ paletteOpen: true });
        else if (s.overlay === 'jobPanel') st.set({ jobPanelOpen: true });
        else st.openFind();
      } else if (s.kind === 'dialog' && s.dialog) {
        st.openDialog(s.dialog, data);
      }
    },
    { s: screen, data: screen.dialog ? dialogData(screen.dialog, source) : undefined },
  );
  if (screen.kind !== 'dialog') {
    await page.waitForTimeout(400);
    return true;
  }
  try {
    await page.locator('.dlg').first().waitFor({ state: 'visible', timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chuẩn bị trước khi đo/chụp: tắt hoạt ảnh và con trỏ, chờ font, theme sáng, chuột ra khỏi
 * màn hình (tooltip không bật). Trả về false nếu còn spinner trong hộp thoại sau 10 giây.
 */
export async function prepare(page: Page): Promise<boolean> {
  await page.evaluate((theme) => {
    if (!document.getElementById('ui-audit-style')) {
      const style = document.createElement('style');
      style.id = 'ui-audit-style';
      style.textContent =
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.append(style);
    }
    document.documentElement.dataset.theme = theme;
    (document.activeElement as HTMLElement | null)?.blur();
  }, THEME_NAME);
  await page.emulateMedia({ colorScheme: THEME_NAME }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  try {
    await page.waitForFunction(() => !document.querySelector('.dlg .spinner'), undefined, {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Thay hộp thoại hệ thống bằng hàm giả: không bao giờ treo chờ người bấm. */
export async function stubNativeDialogs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as never;
    dialog.showSaveDialog = (async () => ({ canceled: true, filePath: undefined })) as never;
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
  });
}

/** Ghi lại console (error, warning) và lỗi trang; báo cáo cắt theo mốc của từng màn hình. */
export class Diagnostics {
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];

  attach(page: Page): void {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        this.consoleErrors.push(`${m.type()}: ${m.text()}`.slice(0, 300));
      }
    });
    page.on('pageerror', (e) => this.pageErrors.push(String(e.message).slice(0, 300)));
  }

  mark(): { c: number; p: number } {
    return { c: this.consoleErrors.length, p: this.pageErrors.length };
  }

  since(m: { c: number; p: number }): { consoleErrors: string[]; pageErrors: string[] } {
    return {
      consoleErrors: this.consoleErrors.slice(m.c, m.c + 20),
      pageErrors: this.pageErrors.slice(m.p, m.p + 20),
    };
  }
}

// ---------- Dist cũ và báo cáo ----------

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx|css)$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** So mtime: nếu nguồn giao diện mới hơn dist thì dist đã cũ (chưa build lại). */
export function distStatus(): {
  distBuiltAt: string | null;
  srcNewestAt: string | null;
  staleDist: boolean;
} {
  if (!fs.existsSync(DIST_INDEX)) return { distBuiltAt: null, srcNewestAt: null, staleDist: true };
  const distMs = fs.statSync(DIST_INDEX).mtimeMs;
  const srcMs = Math.max(0, ...walkFiles(SRC_DIR).map((f) => fs.statSync(f).mtimeMs));
  return {
    distBuiltAt: new Date(distMs).toISOString(),
    srcNewestAt: new Date(srcMs).toISOString(),
    staleDist: srcMs > distMs,
  };
}

export function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export type ScreenStatus = 'ok' | 'open-failed' | 'settle-timeout' | 'error';

export interface ScreenResult {
  name: string;
  kind: Screen['kind'];
  status: ScreenStatus;
  settled: boolean;
  dialogTitle: string | null;
  /** Đường dẫn tương đối trong ui-audit-out (shots/...). */
  shot: string | null;
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
  ms: number;
  /** Nhóm phát hiện theo luật (uiAuditRules.ts). */
  findings: AuditGroup[];
  /** Số phần tử đã đo và số điều khiển trong đó: để thấy bộ đo có quét thật không. */
  scanned: number;
  controls: number;
}

export interface AuditReport {
  meta: {
    commit: string;
    generatedAt: string;
    viewport: typeof VIEWPORT;
    dpr: number;
    theme: 'light' | 'dark';
    distBuiltAt: string | null;
    srcNewestAt: string | null;
    staleDist: boolean;
    screensPlanned: number;
  };
  screens: ScreenResult[];
  summary: Record<ScreenStatus, number> & { total: number };
}

export function summarize(screens: ScreenResult[]): AuditReport['summary'] {
  const summary = { total: screens.length, ok: 0, 'open-failed': 0, 'settle-timeout': 0, error: 0 };
  for (const s of screens) summary[s.status] += 1;
  return summary;
}

export function writeReport(report: AuditReport): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
}

/** Tên file ảnh chụp từ tên màn hình (không có : hay /). */
export function shotName(screenName: string): string {
  return `${screenName.replace(/[^A-Za-z0-9_-]+/g, '_')}.png`;
}
