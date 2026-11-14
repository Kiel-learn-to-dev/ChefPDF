/** Memory per process in the packaged app (opt-in, T11.02). Set CHEF_E2E_EXE to the packaged exe
 * and CHEF_PERF_DIR to a folder with pages1000.pdf and tab1.pdf to tab5.pdf (copies of it).
 *
 * It prints one `PERFMEM` line per snapshot: the Electron processes from app.getAppMetrics(), the
 * core (chef-core.exe) from the process table, dedicated workers (pdf.js), and where the renderer
 * keeps its bytes: JS heap (after a forced GC), DOM nodes and listeners, canvas bytes, DPR. The
 * scroll test also counts long tasks (> 50 ms). It asserts nothing: the numbers go to NOTES.md,
 * before and after each fix.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchUnderTest, removeTempDirs, type Launched } from '../fixtures/app';

const exe = process.env.CHEF_E2E_EXE ?? '';
const perfDir = process.env.CHEF_PERF_DIR ?? '';
/** Optional device scale factor (e.g. 1.5), to model a laptop at 150 % scaling. */
const dpr = process.env.CHEF_PERF_DPR ?? '';

test.describe.configure({ mode: 'serial' });
test.skip(!exe, 'set CHEF_E2E_EXE to the packaged exe');
test.skip(!perfDir, 'set CHEF_PERF_DIR to the folder with pages1000.pdf and tab1..5.pdf');

interface Proc {
  pid: number;
  ppid: number;
  name: string;
  /** Working set in bytes (Windows). */
  ws: number;
}

function processTable(): Proc[] {
  let out: string;
  try {
    out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8' },
    );
  } catch {
    // A failed process query must not fail the test; the snapshot shows core=n/a instead.
    return [];
  }
  const rows = JSON.parse(out) as {
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
    WorkingSetSize: number;
  }[];
  return rows.map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    name: r.Name,
    ws: r.WorkingSetSize,
  }));
}

function descendants(all: Proc[], root: number): Proc[] {
  const out: Proc[] = [];
  const frontier = [root];
  while (frontier.length) {
    const parent = frontier.pop()!;
    for (const p of all) {
      if (p.ppid === parent && !out.includes(p)) {
        out.push(p);
        frontier.push(p.pid);
      }
    }
  }
  return out;
}

const mb = (bytes: number): string => (bytes / 1048576).toFixed(0);

interface Cdp {
  send(method: string, params?: object): Promise<any>;
}

async function openCdp(l: Launched): Promise<Cdp | null> {
  try {
    return (await l.app.context().newCDPSession(l.page)) as unknown as Cdp;
  } catch {
    return null;
  }
}

/** Dedicated workers (pdf.js) and the renderer's heap, DOM and canvas bytes after a forced GC. */
async function rendererDetail(cdp: Cdp | null, l: Launched): Promise<string> {
  if (!cdp) return 'cdp=n/a';
  const { targetInfos } = await cdp.send('Target.getTargets');
  const workers = targetInfos.filter((t: { type: string }) => t.type === 'worker').length;
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  const dom = (await cdp.send('Memory.getDOMCounters').catch(() => null)) as {
    nodes: number;
    jsEventListeners: number;
  } | null;
  const canvas = await l.page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    const bytes = cs.reduce((sum, c) => sum + c.width * c.height * 4, 0);
    return {
      count: cs.length,
      bytes,
      dpr: window.devicePixelRatio,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollTop: Math.round(document.querySelector('.viewer__scroll')?.scrollTop ?? -1),
      pagesWithCanvas: document.querySelectorAll('.pdfViewer .page canvas').length,
      elements: document.getElementsByTagName('*').length,
    };
  });
  return (
    `workers=${workers} heapMB=${mb(heap.usedSize)} ` +
    `domNodes=${dom?.nodes ?? 'n/a'} listeners=${dom?.jsEventListeners ?? 'n/a'} ` +
    `canvases=${canvas.count} canvasMB=${mb(canvas.bytes)} pagesWithCanvas=${canvas.pagesWithCanvas} ` +
    `elements=${canvas.elements} viewport=${canvas.viewportWidth}x${canvas.viewportHeight} ` +
    `dpr=${canvas.dpr} scrollTop=${canvas.scrollTop}`
  );
}

/** One line per snapshot: Electron process working sets, core working set, renderer detail. */
async function snapshot(l: Launched, label: string, cdp: Cdp | null): Promise<void> {
  const electron = await l.app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      ws: m.memory.workingSetSize * 1024,
    })),
  );
  const pid = l.app.process().pid;
  if (pid === undefined) throw new Error('Electron main process has no pid');
  const tree = descendants(processTable(), pid);
  const core = tree.filter((p) => /python|chef-core/i.test(p.name));
  const byType = new Map<string, number>();
  for (const m of electron) byType.set(m.type, (byType.get(m.type) ?? 0) + m.ws);
  const electronTotal = electron.reduce((sum, m) => sum + m.ws, 0);
  const coreTotal = core.reduce((sum, p) => sum + p.ws, 0);
  const thumbs = await l.page.locator('.page-thumb img').count();
  const detail = await rendererDetail(cdp, l);
  const parts = [...byType].map(([type, ws]) => `${type}=${mb(ws)}`).join(' ');
  console.log(
    `PERFMEM ${label} electronMB=${mb(electronTotal)} (${parts}) coreMB=${mb(coreTotal)} ` +
      `coreProcs=${core.length} thumbImgs=${thumbs} ${detail}`,
  );
}

let launched: Launched | null = null;

/** Chromium switches (space separated) for an experiment, e.g. "--disable-gpu-compositing". */
const switches = (process.env.CHEF_PERF_SWITCHES ?? '').split(/\s+/).filter(Boolean);

function launchArgs(files: string[]): string[] {
  // Switches first: the app's file parser skips arguments that start with "-".
  const dprArg = dpr ? [`--force-device-scale-factor=${dpr}`] : [];
  return [...dprArg, ...switches, ...files];
}

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

test('idle with no document', async () => {
  test.setTimeout(120_000);
  launched = await launchUnderTest({ args: launchArgs([]) });
  await launched.page.waitForTimeout(5_000);
  await snapshot(launched, 'idle', await openCdp(launched));
});

test('one 1000-page document: open, scroll 350 screens, return to the top', async () => {
  test.setTimeout(900_000);
  launched = await launchUnderTest({ args: launchArgs([path.join(perfDir, 'pages1000.pdf')]) });
  const page = launched.page;
  // Match the native E2E window (main.rs DEFAULT_SIZE = 1200×860 logical px).
  await page.setViewportSize({ width: 1200, height: 860 });
  const cdp = await openCdp(launched);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 300_000 });
  await page.waitForTimeout(3_000);
  await snapshot(launched, 'open-1000', cdp);
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: { count: number; max: number; total: number } };
    w.__longTasks = { count: 0, max: 0, total: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__longTasks.count += 1;
        w.__longTasks.total += e.duration;
        w.__longTasks.max = Math.max(w.__longTasks.max, e.duration);
      }
    }).observe({ entryTypes: ['longtask'] });
  });
  // Match the native R1.37 scenario: one content viewport every 150 ms. PageDown from the keyboard
  // stalls in the offscreen window (frames are not produced), so set scrollTop directly.
  const screens = 350;
  const start = await page.evaluate(() => {
    const el = document.querySelector('.viewer__scroll');
    return { scrollTop: el?.scrollTop ?? -1, viewportH: el?.clientHeight ?? 0 };
  });
  expect(start.viewportH).toBeGreaterThan(0);
  expect(start.scrollTop).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < screens; i += 1) {
    await page.evaluate(() => {
      const el = document.querySelector('.viewer__scroll');
      if (el) el.scrollTop += el.clientHeight;
    });
    await page.waitForTimeout(150);
  }
  const scrolled = await page.evaluate(() => {
    const el = document.querySelector('.viewer__scroll');
    return { scrollTop: el?.scrollTop ?? -1 };
  });
  expect(scrolled.scrollTop - start.scrollTop).toBeGreaterThanOrEqual(start.viewportH * screens * 0.99);
  await page.waitForTimeout(3_000);
  await snapshot(launched, `after-scroll-${screens}`, cdp);
  const lt = await page.evaluate(
    () =>
      (window as unknown as { __longTasks: { count: number; max: number; total: number } })
        .__longTasks,
  );
  console.log(
    `PERFMEM longtasks count=${lt.count} maxMs=${Math.round(lt.max)} totalMs=${Math.round(lt.total)} ` +
      `switches="${switches.join(' ')}"`,
  );
  for (let i = 0; i < screens; i += 1) {
    await page.evaluate(() => {
      const el = document.querySelector('.viewer__scroll');
      if (el) el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
    });
    await page.waitForTimeout(150);
  }
  const top = await page.evaluate(() => document.querySelector('.viewer__scroll')?.scrollTop ?? -1);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThanOrEqual(2);
  await page.waitForTimeout(3_000);
  await snapshot(launched, 'return-top', cdp);
});

test('five tabs, each visited, then all closed', async () => {
  test.setTimeout(600_000);
  const files = [1, 2, 3, 4, 5].map((n) => path.join(perfDir, `tab${n}.pdf`));
  launched = await launchUnderTest({ args: launchArgs(files) });
  const page = launched.page;
  const cdp = await openCdp(launched);
  await expect(page.locator('.doctab__close')).toHaveCount(5, { timeout: 120_000 });
  for (let i = 0; i < 5; i += 1) {
    // Document tabs only: the first wrapper is the brand tab, which has no close button.
    await page
      .locator('.doctab-wrap:has(.doctab__close)')
      .nth(i)
      .locator('[role="tab"]')
      .first()
      .click();
    await page.waitForSelector('.pdfViewer .page', { state: 'attached', timeout: 120_000 });
    await page.waitForTimeout(2_000);
    await snapshot(launched, `tab-${i + 1}-visited`, cdp);
  }
  for (let i = 0; i < 5; i += 1) {
    await page.locator('.doctab__close').first().click();
    await page.waitForTimeout(1_500);
  }
  await page.waitForTimeout(3_000);
  await snapshot(launched, 'all-closed', cdp);
  // Does the memory come back once the renderer has had time, and under memory pressure?
  await page.waitForTimeout(30_000);
  await snapshot(launched, 'closed-30s', cdp);
  await cdp?.send('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => null);
  await page.waitForTimeout(10_000);
  await snapshot(launched, 'closed-pressure', cdp);
});
