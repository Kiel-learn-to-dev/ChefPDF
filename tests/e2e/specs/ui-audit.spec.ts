/**
 * Bộ đo giao diện (kế hoạch docs/UI_AUDIT.md mục 2): mở từng màn hình với lõi Python THẬT, đo
 * theo luật (uiAuditRules.ts), chụp ảnh có khung đỏ, ghi tests/e2e/ui-audit-out/ (report.json,
 * report.md, shots/). Thêm biến thể cho từng tab và mục "nâng cao" đang đóng trong hộp thoại.
 *
 * Mặc định chỉ báo cáo, không fail. Các chế độ (biến môi trường):
 * - UI_AUDIT_UPDATE=1: ghi tests/e2e/ui-audit-baseline.json (từ chối nếu dist cũ hoặc DPR ≠ 1).
 * - UI_AUDIT_STRICT=1: so số phát hiện theo (màn hình, luật) với baseline, fail khi số tăng.
 * - UI_AUDIT_SNAPSHOT=1: chụp ảnh gốc (không khung đỏ) so pixel với tests/e2e/ui-audit-snapshots/.
 * - UI_AUDIT_ONLY=dialog:merge,main:view: chọn màn hình (khớp một phần tên).
 *
 * Chạy: pnpm --filter @chef/ui build && pnpm --filter @chef/e2e exec playwright test ui-audit
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, removeTempDirs, repoRoot, type Launched } from '../fixtures/app';
import {
  Diagnostics,
  DIST_INDEX,
  OUT_DIR,
  SHOT_DIR,
  THEME,
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
import {
  attachCssHits,
  buildCssIndex,
  clearMarks,
  countsOf,
  DEVICE_DIALOGS,
  drawMarks,
  listVariants,
  readBaseline,
  writeBaseline,
  writeMarkdown,
  type VariantTarget,
} from '../fixtures/uiAuditReport';
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
const mode =
  process.env.UI_AUDIT_UPDATE === '1'
    ? 'update'
    : process.env.UI_AUDIT_STRICT === '1'
      ? 'strict'
      : 'report';
const snapshotMode = process.env.UI_AUDIT_SNAPSHOT === '1';
/** Màn hình có ảnh khác ảnh gốc (chế độ snapshot). Test cuối báo lỗi nếu còn. */
const snapshotDiffs: string[] = [];

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
  // DPR thật của trang (khác 1 thì baseline không so được, xem test cuối).
  report.meta.dpr = await l.page.evaluate(() => window.devicePixelRatio);
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

async function shoot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = shotName(name);
  await page.screenshot({ path: path.join(SHOT_DIR, file) });
  return `shots/${file}`;
}

/**
 * Đo một trạng thái đã mở: chuẩn bị, (tùy chọn) so ảnh gốc, chạy luật, vẽ khung đỏ, chụp, xóa khung.
 * Thứ tự này giữ ảnh so sánh không có khung đỏ.
 */
async function measureNow(page: Page, r: ScreenResult, name: string): Promise<void> {
  r.settled = await prepare(page);
  if (!r.settled) r.status = 'settle-timeout';
  if (snapshotMode) {
    // Không dùng expect.soft: trong serial, một test lỗi sẽ làm bỏ qua các test sau.
    // Lỗi được gom vào snapshotDiffs và test cuối mới fail.
    // Ô có mã sinh ngẫu nhiên (workflow-xxxx) đổi mỗi lần mở: che đi, không tính là khác biệt.
    await page.evaluate(() =>
      document.querySelectorAll('input').forEach((i) => {
        if (/^workflow-[a-z0-9]+$/i.test(i.value)) i.setAttribute('data-audit-mask', '1');
      }),
    );
    try {
      await expect(page).toHaveScreenshot(`${name.replace(/[^A-Za-z0-9_-]+/g, '_')}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixels: 0,
        mask: [page.locator('[data-audit-mask]')],
      });
    } catch (e) {
      snapshotDiffs.push(`${name}: ${String(e).split('\n').slice(0, 2).join(' ').slice(0, 200)}`);
    }
  }
  const res = await page.evaluate(auditInPage, AUDIT_CFG);
  r.findings = res.groups;
  r.scanned = res.scanned;
  r.controls = res.controls;
  // Ảnh sạch (không khung đỏ) cho bộ tham chiếu R2.01: ghi ra thư mục ngoài repo khi có UI_AUDIT_CLEAN_DIR.
  const cleanDir = process.env.UI_AUDIT_CLEAN_DIR;
  if (cleanDir) {
    fs.mkdirSync(cleanDir, { recursive: true });
    await page.screenshot({ path: path.join(cleanDir, shotName(name)) });
  }
  await drawMarks(page, r.findings);
  r.shot = await shoot(page, name);
  await clearMarks(page);
}

/** Màn start: chạy riêng, không mở tài liệu. */
async function auditStart(
  screen: Screen = { name: 'start', kind: 'start' },
): Promise<ScreenResult> {
  const r = blank(screen);
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
  if (screen.kind === 'about') {
    // The About tab opens over the start screen (1.2): its own screen, measured the same way.
    await startApp.page.locator('.doctab--about').click();
    await startApp.page.locator('.about').waitFor({ state: 'visible', timeout: 30_000 });
  }
  await measureNow(startApp.page, r, screen.name);
  Object.assign(r, diag.since({ c: 0, p: 0 }));
  return r;
}

/** Một biến thể (tab hoặc mục nâng cao) của hộp thoại: mở lại từ đầu rồi bấm đúng mục đó. */
async function auditVariant(
  l: Launched & { diag: Diagnostics },
  screen: Screen,
  t: VariantTarget,
): Promise<ScreenResult> {
  const name = `${screen.name}#${t.kind}${t.index}:${t.label}`;
  const v = blank({ name, kind: 'dialog' });
  const mark = l.diag.mark();
  try {
    await resetScreen(l.page);
    const opened = await openScreen(l.page, screen, source);
    if (!opened) {
      v.status = 'open-failed';
      return v;
    }
    const sel =
      t.kind === 'tab' ? '.dlg[role=dialog] [role=tab]' : '.dlg[role=dialog] .collapsible__trigger';
    await l.page.locator(sel).nth(t.index).click({ timeout: 3_000 });
    await measureNow(l.page, v, name);
  } catch (e) {
    v.status = 'error';
    v.error = String(e).slice(0, 300);
  } finally {
    Object.assign(v, l.diag.since(mark));
  }
  return v;
}

/**
 * Chế độ Chỉnh sửa (T12.08): mở tab, bật "Sửa chữ" bằng thao tác giao diện, và với
 * edit:paragraph còn chọn một đoạn để hàng định dạng bật. Không ném lỗi.
 */
/** Bật hoặc tắt chế độ Chỉnh sửa: bấm nút chỉ khi trạng thái (aria-pressed) khác yêu cầu. */
async function setEditMode(page: Page, on: boolean): Promise<void> {
  const btn = page.locator('.toolbar__btn', { hasText: 'Sửa chữ' });
  const pressed = (await btn.getAttribute('aria-pressed')) === 'true';
  if (pressed !== on) await btn.click();
}

async function auditEditScreen(screen: Screen): Promise<ScreenResult[]> {
  const r = blank(screen);
  const l = await ensureDoc();
  const mark = l.diag.mark();
  try {
    await resetScreen(l.page);
    await l.page.click('.ftab >> text=Chỉnh sửa');
    await setEditMode(l.page, true);
    if (screen.name === 'edit:paragraph') {
      const line = l.page.locator('[data-testid="tedit-box"]').first();
      await line.waitFor({ timeout: 30_000 });
      const b = await line.boundingBox();
      if (!b) throw new Error('dòng chữ không có khung');
      // Chọn cả dòng bằng cách kéo (D65): hàng định dạng áp cho đoạn của chữ đã chọn.
      await l.page.mouse.move(b.x + 1, b.y + b.height / 2);
      await l.page.mouse.down();
      await l.page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
      await l.page.mouse.up();
      await l.page
        .getByRole('toolbar', { name: 'Định dạng chữ' })
        .getByRole('button', { name: 'In đậm' })
        .waitFor({ state: 'visible', timeout: 10_000 });
    }
    await measureNow(l.page, r, screen.name);
  } catch (e) {
    r.status = 'error';
    r.error = String(e).slice(0, 300);
  } finally {
    // The later screens (dialogs) must not see the edit mode or its format bar.
    await setEditMode(l.page, false).catch(() => undefined);
    Object.assign(r, l.diag.since(mark));
  }
  return [r];
}

/**
 * Một màn hình trong tài liệu đang mở, kèm biến thể của hộp thoại (trừ hộp thoại thiết bị).
 * Không ném lỗi: mọi lỗi ghi vào báo cáo.
 */
async function auditDocScreen(screen: Screen): Promise<ScreenResult[]> {
  const r = blank(screen);
  const out: ScreenResult[] = [r];
  const l = await ensureDoc();
  const mark = l.diag.mark();
  try {
    await resetScreen(l.page);
    const opened = await openScreen(l.page, screen, source);
    if (!opened) {
      r.status = 'open-failed';
      r.shot = await shoot(l.page, screen.name);
      return out;
    }
    if (screen.kind === 'dialog') {
      r.dialogTitle = await l.page
        .locator('.dlg__title')
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => null);
    }
    await measureNow(l.page, r, screen.name);
    if (screen.kind === 'dialog' && screen.dialog && !DEVICE_DIALOGS.has(screen.dialog)) {
      for (const t of await listVariants(l.page)) {
        out.push(await auditVariant(l, screen, t));
      }
    }
  } catch (e) {
    r.status = 'error';
    r.error = String(e).slice(0, 300);
  } finally {
    Object.assign(r, l.diag.since(mark));
  }
  return out;
}

test.describe('UI audit (report only)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);
  test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

  const screens = buildScreens();

  test.beforeAll(() => {
    // Thư mục cố định: đường dẫn hiện trong hộp "Lưu vào thư mục" nếu đổi mỗi lần thì ảnh lệch.
    corpus = path.join(OUT_DIR, 'corpus');
    fs.rmSync(corpus, { recursive: true, force: true });
    fs.mkdirSync(corpus, { recursive: true });
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
        theme: THEME,
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
      attachCssHits(results, buildCssIndex());
      writeReport(report);
      writeMarkdown(report);
      console.log(
        `UI_AUDIT: ${JSON.stringify(report.summary)} -> ${path.join(OUT_DIR, 'report.json')} và report.md`,
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
      if (screen.kind === 'start' || screen.kind === 'about') {
        let r: ScreenResult;
        try {
          r = await auditStart(screen);
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
      const found =
        screen.kind === 'edit' ? await auditEditScreen(screen) : await auditDocScreen(screen);
      for (const r of found) {
        r.ms = Date.now() - started;
        record(r);
      }
    });
  }

  // Cuối lượt: ghi hoặc so baseline. Chỉ test này fail khi số phát hiện tăng (chế độ strict).
  test('baseline (số phát hiện theo màn hình và luật)', () => {
    // Baseline và snapshot chỉ là số đo của 1280×820 sáng: cỡ khác không được ghi đè.
    if ((mode !== 'report' || snapshotMode) && (VIEWPORT.width !== 1280 || THEME === 'dark')) {
      throw new Error(
        'baseline/snapshot chỉ chạy ở 1280×820 sáng (bỏ UI_AUDIT_VIEWPORT và UI_AUDIT_THEME)',
      );
    }
    if (snapshotMode) {
      expect(snapshotDiffs, 'ảnh khác ảnh gốc (chế độ snapshot)').toEqual([]);
    }
    if (mode === 'report') {
      console.log('UI_AUDIT: chế độ báo cáo, không ghi và không so baseline');
      return;
    }
    if (report.meta.staleDist) {
      throw new Error(
        'dist cũ: build lại UI (pnpm --filter @chef/ui build) trước khi ghi/so baseline',
      );
    }
    if (report.meta.dpr !== 1) {
      throw new Error(
        `DPR ${report.meta.dpr}: baseline chỉ ghi/so ở DPR 1 (tắt scale của Windows hoặc dùng --force-device-scale-factor=1)`,
      );
    }
    if (mode === 'update') {
      writeBaseline(report, results);
      console.log(`UI_AUDIT: đã ghi baseline (${results.length} màn hình)`);
      return;
    }
    const base = readBaseline();
    if (!base) throw new Error('chưa có baseline: chạy với UI_AUDIT_UPDATE=1 trước');
    const regressions: string[] = [];
    for (const [screen, rules] of Object.entries(countsOf(results))) {
      for (const [rule, n] of Object.entries(rules)) {
        const b = base.counts[screen]?.[rule] ?? 0;
        if (n > b) regressions.push(`${screen} ${rule}: ${b} -> ${n}`);
      }
    }
    expect(regressions, 'số phát hiện tăng so với baseline').toEqual([]);
  });
});
