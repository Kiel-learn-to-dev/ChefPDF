/** Heap snapshot of the renderer after scrolling a large document (opt-in, measurement only).
 * Set CHEF_E2E_EXE to the packaged exe, CHEF_PERF_DIR to the folder with pages1000.pdf, and
 * CHEF_PERF_HEAP to the file the snapshot is written to. It asserts nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { launchUnderTest, removeTempDirs } from '../fixtures/app';

const exe = process.env.CHEF_E2E_EXE ?? '';
const perfDir = process.env.CHEF_PERF_DIR ?? '';
const heapFile = process.env.CHEF_PERF_HEAP ?? '';
const steps = Number(process.env.CHEF_PERF_HEAP_STEPS ?? '350');

test.skip(!exe, 'set CHEF_E2E_EXE to the packaged exe');
test.skip(!perfDir, 'set CHEF_PERF_DIR to the folder with pages1000.pdf');
test.skip(!heapFile, 'set CHEF_PERF_HEAP to the snapshot file to write');

test.afterAll(() => {
  removeTempDirs();
});

test('heap snapshot after scrolling the 1000-page document', async () => {
  test.setTimeout(900_000);
  const launched = await launchUnderTest({ args: [path.join(perfDir, 'pages1000.pdf')] });
  const page = launched.page;
  try {
    await page.waitForSelector('.pdfViewer .page canvas', { timeout: 300_000 });
    await page.waitForTimeout(3_000);
    for (let i = 0; i < steps; i += 1) {
      await page.evaluate(() => {
        const el = document.querySelector('.viewer__scroll');
        if (el) el.scrollTop += el.clientHeight;
      });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(3_000);

    const cdp = (await launched.app.context().newCDPSession(page)) as unknown as {
      send(method: string, params?: object): Promise<unknown>;
      on(event: string, listener: (e: { chunk: string }) => void): void;
    };
    fs.mkdirSync(path.dirname(heapFile), { recursive: true });
    const out = fs.createWriteStream(heapFile);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => out.write(e.chunk));
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    await new Promise<void>((resolve) => out.end(resolve));
    console.log(`PERFHEAP written ${heapFile} bytes=${fs.statSync(heapFile).size}`);
  } finally {
    const proc = launched.app.process();
    await Promise.race([launched.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});
