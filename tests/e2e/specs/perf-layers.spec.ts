/** Compositor layers of the renderer after scrolling a large document (opt-in, measurement only).
 * Set CHEF_E2E_EXE to the packaged exe and CHEF_PERF_DIR to the folder with pages1000.pdf.
 * It prints the number of layers and the pixel area of the layers that draw content, from CDP's
 * LayerTree domain. It asserts nothing.
 */
import path from 'node:path';
import { test } from '@playwright/test';
import { launchUnderTest, removeTempDirs } from '../fixtures/app';

const exe = process.env.CHEF_E2E_EXE ?? '';
const perfDir = process.env.CHEF_PERF_DIR ?? '';
const steps = Number(process.env.CHEF_PERF_LAYER_STEPS ?? '350');

test.skip(!exe, 'set CHEF_E2E_EXE to the packaged exe');
test.skip(!perfDir, 'set CHEF_PERF_DIR to the folder with pages1000.pdf');

test.afterAll(() => {
  removeTempDirs();
});

interface Layer {
  layerId: string;
  width: number;
  height: number;
  drawsContent: boolean;
  paintCount?: number;
  offsetX?: number;
  offsetY?: number;
}

test('compositor layers after scrolling the 1000-page document', async () => {
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
      on(event: string, listener: (e: { layers: Layer[] }) => void): void;
    };
    let layers: Layer[] = [];
    cdp.on('LayerTree.layerTreeDidChange', (e) => {
      if (e.layers) layers = e.layers;
    });
    await cdp.send('LayerTree.enable');
    // A small scroll makes the compositor report the tree again.
    await page.evaluate(() => {
      const el = document.querySelector('.viewer__scroll');
      if (el) el.scrollTop += 1;
    });
    await page.waitForTimeout(3_000);
    await cdp.send('LayerTree.disable');

    const drawing = layers.filter((l) => l.drawsContent);
    const area = drawing.reduce((sum, l) => sum + l.width * l.height, 0);
    const biggest = [...drawing]
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, 3);
    console.log(
      `PERFLAYERS steps=${steps} layers=${layers.length} drawing=${drawing.length} ` +
        `drawingMB=${((area * 4) / 1048576).toFixed(0)} ` +
        `largest=${biggest.map((l) => `${l.width}x${l.height}`).join(',')}`,
    );
  } finally {
    const proc = launched.app.process();
    await Promise.race([launched.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
});
