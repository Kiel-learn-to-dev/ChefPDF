/** Smoothness of real wheel scrolling on the 1000-page document (opt-in, measurement only).
 * Set CHEF_E2E_EXE to the packaged exe, CHEF_PERF_DIR to the folder with pages1000.pdf, and
 * CHEF_PERF_LABEL to a name for the build (printed with the numbers).
 *
 * The window is shown (CHEF_E2E_SHOW), so frames are produced. Wheel events go through Chromium's
 * input pipeline with page.mouse.wheel; the OS cursor does not move. It prints PERFWHEEL with the
 * frame gaps (requestAnimationFrame) and the long tasks during the wheel run. It asserts nothing.
 */
import path from 'node:path';
import { test } from '@playwright/test';
import { launchUnderTest, removeTempDirs } from '../fixtures/app';

const exe = process.env.CHEF_E2E_EXE ?? '';
const perfDir = process.env.CHEF_PERF_DIR ?? '';
const label = process.env.CHEF_PERF_LABEL ?? 'build';
const wheelEvents = Number(process.env.CHEF_PERF_WHEEL_EVENTS ?? '240');

test.skip(!exe, 'set CHEF_E2E_EXE to the packaged exe');
test.skip(!perfDir, 'set CHEF_PERF_DIR to the folder with pages1000.pdf');

test.afterAll(() => {
  removeTempDirs();
});

interface Stats {
  frames: number;
  gapMax: number;
  over50: number;
  over100: number;
  longTasks: number;
  longTaskMax: number;
  longTaskTotal: number;
}

test('wheel scrolling of the 1000-page document', async () => {
  test.setTimeout(900_000);
  const launched = await launchUnderTest({
    args: [path.join(perfDir, 'pages1000.pdf')],
    visible: true,
  });
  const page = launched.page;
  try {
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 300_000 });
    await page.waitForTimeout(3_000);

    const box = await page.locator('.viewer__scroll').boundingBox();
    if (!box) throw new Error('no viewer scroll area');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await page.evaluate(() => {
      const w = window as unknown as {
        __frames: number[];
        __stop: boolean;
        __lt: { count: number; max: number; total: number };
      };
      w.__frames = [];
      w.__stop = false;
      w.__lt = { count: 0, max: 0, total: 0 };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          w.__lt.count += 1;
          w.__lt.total += e.duration;
          w.__lt.max = Math.max(w.__lt.max, e.duration);
        }
      }).observe({ entryTypes: ['longtask'] });
      const tick = (t: number) => {
        w.__frames.push(t);
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const before = await page.evaluate(
      () => document.querySelector('.viewer__scroll')?.scrollTop ?? 0,
    );
    for (let i = 0; i < wheelEvents; i += 1) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(1_500);
    const after = await page.evaluate(
      () => document.querySelector('.viewer__scroll')?.scrollTop ?? 0,
    );

    const stats = await page.evaluate<Stats>(() => {
      const w = window as unknown as {
        __frames: number[];
        __stop: boolean;
        __lt: { count: number; max: number; total: number };
      };
      w.__stop = true;
      const f = w.__frames;
      let gapMax = 0;
      let over50 = 0;
      let over100 = 0;
      for (let i = 1; i < f.length; i += 1) {
        const gap = f[i]! - f[i - 1]!;
        gapMax = Math.max(gapMax, gap);
        if (gap > 50) over50 += 1;
        if (gap > 100) over100 += 1;
      }
      return {
        frames: f.length,
        gapMax: Math.round(gapMax),
        over50,
        over100,
        longTasks: w.__lt.count,
        longTaskMax: Math.round(w.__lt.max),
        longTaskTotal: Math.round(w.__lt.total),
      };
    });

    console.log(
      `PERFWHEEL label=${label} events=${wheelEvents} scrolled=${Math.round(after - before)} ` +
        `frames=${stats.frames} gapMaxMs=${stats.gapMax} framesOver50=${stats.over50} ` +
        `framesOver100=${stats.over100} longTasks=${stats.longTasks} ` +
        `longTaskMaxMs=${stats.longTaskMax} longTaskTotalMs=${stats.longTaskTotal}`,
    );
  } finally {
    const proc = launched.app.process();
    await Promise.race([launched.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});
