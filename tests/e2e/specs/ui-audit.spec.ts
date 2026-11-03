/**
 * Bộ đo giao diện, lượt A3 (kế hoạch docs/UI_AUDIT.md mục 2): mở từng màn hình với lõi Python
 * THẬT, chụp ảnh, ghi tests/e2e/ui-audit-out/report.json. Lượt này chỉ mở và chụp; luật đo
 * (khoảng cách, lệch hàng, tràn chữ...) thêm ở các lượt sau.
 *
 * Mặc định chỉ báo cáo, không fail: mỗi màn hình có try/catch, một lỗi không dừng cả lượt.
 * Chạy: pnpm --filter @chef/ui build && pnpm --filter @chef/e2e exec playwright test ui-audit
 * Chọn màn hình: UI_AUDIT_ONLY=dialog:merge,main:view (khớp một phần tên).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';
import {
  Diagnostics,
  DIST_INDEX,
  SHOT_DIR,
  VIEWPORT,
  buildScreens,
  distStatus,
  gitCommit,
  hasHook,
  openScreen,
  prepare,
  resetScreen,
  shotName,
  stubNativeDialogs,
  summarize,
  writeReport,
  type AuditReport,
  type Screen,
  type ScreenResult,
} from '../fixtures/uiAudit';
import { AUDIT_CFG, auditInPage } from '../fixtures/uiAuditRules';

const coreDir = path.join(repoRoot, 'core');
const realCoreCmd = `uv run --project "${coreDir}" python -m chef_core`;
const fixturesDir = path.join(repoRoot, 'tests', 'e2e', 'fixtures');
const uiBuilt = fs.existsSync(DIST_INDEX);
const only = (process.env.UI_AUDIT_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const wanted = (name: string): boolean => only.length === 0 || only.some((o) => name.includes(o));

let corpus = '';
let source = '';
let doc: (Launched & { diag: Diagnostics }) | null = null;
let startApp: Launched | null = null;
const results: ScreenResult[] = [];
let report: AuditReport;

async function ensureDoc(): Promise<Launched & { diag: Diagnostics }> {
  if (doc && !doc.page.isClosed()) return doc;
  if (doc) await doc.app.close().catch(() => undefined);
  const l = await launchApp({
    args: [source, '--force-device-scale-factor=1'],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  await stubNativeDialogs(l.app);
  await l.page.setViewportSize(VIEWPORT);
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  if (!(await hasHook(l.page))) {
    throw new Error('dist thiếu window.__chefUi: build lại UI (pnpm --filter @chef/ui build)');
  }
  const diag = new Diagnostics();
  diag.attach(l.page);
  doc = { ...l, diag };
  return doc;
}

async function closeApp(l: Launched | null): Promise<void> {
  if (!l) return;
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

function record(result: ScreenResult): void {
  results.push(result);
  report.screens = results;
  report.summary = summarize(results);
  writeReport(report);
}

/** Màn start: chạy riêng, không mở tài liệu. */
async function auditStart(): Promise<ScreenResult> {
  const r = blank({ name: 'start', kind: 'start' });
  startApp = await launchApp({
    args: ['--force-device-scale-factor=1'],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  await stubNativeDialogs(startApp.app);
  await startApp.page.setViewportSize(VIEWPORT);
  await startApp.page
    .getByRole('heading', { name: 'Quy trình mẫu' })
    .waitFor({ state: 'visible', timeout: 30_000 });
  const diag = new Diagnostics();
  diag.attach(startApp.page);
  r.settled = await prepare(startApp.page);
  Object.assign(r, await audit(startApp.page));
  r.shot = await shoot(startApp.page, 'start');
  Object.assign(r, diag.since({ c: 0, p: 0 }));
  return r;
}

function blank(s: Pick<Screen, 'name' | 'kind'>): ScreenResult {
  return {
    name: s.name,
    kind: s.kind,
    status: 'ok',
    settled: true,
    dialogTitle: null,
    shot: null,
    consoleErrors: [],
    pageErrors: [],
    ms: 0,
    findings: [],
    scanned: 0,
    controls: 0,
  };
}

/** Chạy luật đo trong trang (A4). */
async function audit(page: Page): Promise<Pick<ScreenResult, 'findings' | 'scanned' | 'controls'>> {
  const res = await page.evaluate(auditInPage, AUDIT_CFG);
  return { findings: res.groups, scanned: res.scanned, controls: res.controls };
}

async function shoot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = shotName(name);
  await page.screenshot({ path: path.join(SHOT_DIR, file) });
  return `shots/${file}`;
}

/** Một màn hình trong tài liệu đang mở. Không ném lỗi: mọi lỗi ghi vào báo cáo. */
async function auditDocScreen(screen: Screen): Promise<ScreenResult> {
  const r = blank(screen);
  const l = await ensureDoc();
  const mark = l.diag.mark();
  try {
    await resetScreen(l.page);
    const opened = await openScreen(l.page, screen, source);
    if (!opened) {
      r.status = 'open-failed';
      r.shot = await shoot(l.page, screen.name);
      return r;
    }
    if (screen.kind === 'dialog') {
      r.dialogTitle = await l.page
        .locator('.dlg__title')
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => null);
    }
    r.settled = await prepare(l.page);
    if (!r.settled) r.status = 'settle-timeout';
    Object.assign(r, await audit(l.page));
    r.shot = await shoot(l.page, screen.name);
  } catch (e) {
    r.status = 'error';
    r.error = String(e).slice(0, 300);
  } finally {
    Object.assign(r, l.diag.since(mark));
  }
  return r;
}

test.describe('UI audit (report only)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

  const screens = buildScreens();

  test.beforeAll(() => {
    corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-ui-audit-'));
    execFileSync(
      'uv',
      [
        'run',
        '--project',
        'core',
        'python',
        path.join(fixturesDir, 'tools5_pages_corpus.py'),
        corpus,
      ],
      { cwd: repoRoot, stdio: 'ignore' },
    );
    source = path.join(corpus, 'menu_pages.pdf');
    const dist = distStatus();
    if (dist.staleDist) {
      console.warn(
        `UI_AUDIT: dist cũ (dist ${dist.distBuiltAt}, nguồn mới hơn ${dist.srcNewestAt}). Hãy build lại UI.`,
      );
    }
    report = {
      meta: {
        commit: gitCommit(),
        generatedAt: new Date().toISOString(),
        viewport: VIEWPORT,
        dpr: 1,
        theme: 'light',
        ...dist,
        screensPlanned: screens.length,
      },
      screens: [],
      summary: summarize([]),
    };
    fs.mkdirSync(SHOT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await closeApp(doc);
    await closeApp(startApp);
    doc = null;
    startApp = null;
    removeTempDirs();
    fs.rmSync(corpus, { recursive: true, force: true });
    if (report) {
      writeReport(report);
      console.log(
        `UI_AUDIT: ${JSON.stringify(report.summary)} -> ${path.join(repoRoot, 'tests', 'e2e', 'ui-audit-out', 'report.json')}`,
      );
    }
    for (const s of results) {
      const counts = new Map<string, number>();
      for (const g of s.findings) counts.set(g.rule, (counts.get(g.rule) ?? 0) + g.count);
      const list = [...counts].map(([k, v]) => `${k}=${v}`).join(' ') || '(sạch)';
      console.log(`UI_AUDIT ${s.name} [quét ${s.scanned}, điều khiển ${s.controls}]: ${list}`);
    }
  });

  for (const screen of screens) {
    test(screen.name, async () => {
      if (!wanted(screen.name)) test.skip(true, 'UI_AUDIT_ONLY');
      const started = Date.now();
      if (screen.kind === 'start') {
        let r: ScreenResult;
        try {
          r = await auditStart();
        } catch (e) {
          r = { ...blank(screen), status: 'error', error: String(e).slice(0, 300) };
        } finally {
          await closeApp(startApp);
          startApp = null;
        }
        r.ms = Date.now() - started;
        record(r);
        return;
      }
      const r = await auditDocScreen(screen);
      r.ms = Date.now() - started;
      record(r);
    });
  }
});
