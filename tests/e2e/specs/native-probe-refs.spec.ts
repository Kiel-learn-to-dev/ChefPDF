/**
 * Electron screenshots matching the visual-only sections of the native R1.43 probe.
 * Image files stay outside the repository; only their dimensions and hashes are recorded here.
 * Opt in with CAPTURE_NATIVE_PROBE_REFS=1 after the Electron UI is built; set NATIVE_PROBE_REFS_OUT
 * to a stable visual-refs directory (never %TEMP%).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, repoRoot, type Launched } from '../fixtures/app';
import { DIST_INDEX } from '../fixtures/uiAudit';

const WIDTHS = [800, 1184, 1484] as const;
const HEIGHT = 1600;
const THEMES = ['light', 'dark'] as const;
const DPRS = [1, 1.75] as const;
const OUT_DIR =
  process.env.NATIVE_PROBE_REFS_OUT ??
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'ChefPDF', 'visual-refs', 'native-probes')
    : path.join(os.homedir(), '.local', 'share', 'chef-pdf', 'visual-refs', 'native-probes'));
const MANIFEST_FILE = path.join(repoRoot, 'tests', 'visual', 'native-refs', 'probe-manifest.json');
const ICONS = [
  'check',
  'chevron-down',
  'bold',
  'copy',
  'crop',
  'combine',
  'arrow-left-right',
  'alert-triangle',
  'circle-x',
  'clock',
] as const;

interface Capture {
  file: string;
  theme: string;
  logicalWidth: number;
  logicalHeight: number;
  dpr: number;
  devicePixelRatio: number;
  width: number;
  height: number;
  sha256: string;
}

const captures: Capture[] = [];
const uiBuilt = fs.existsSync(DIST_INDEX);

function isInside(candidate: string, parent: string): boolean {
  const child = path.resolve(candidate).toLowerCase();
  const root = path.resolve(parent).toLowerCase();
  return child === root || child.startsWith(root + path.sep.toLowerCase());
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error('Electron capture is not a PNG.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function nativeIcon(name: (typeof ICONS)[number], size: number): string {
  const file = path.join(repoRoot, 'apps', 'native', 'assets', 'icons', `${name}.svg`);
  return fs
    .readFileSync(file, 'utf8')
    .replace('<svg ', `<svg class="probe-icon" style="width:${size}px;height:${size}px" `);
}

function visualProbeMarkup(width: number): string {
  const columns = Math.max(1, Math.floor((width - 48 - 24 + 12) / (220 + 12)));
  const cards = Array.from(
    { length: columns * 2 },
    (_, i) => `<div class="probe-card">ô ${i + 1}</div>`,
  ).join('');
  const iconRows = [16, 18]
    .map(
      (size) =>
        `<div class="probe-icon-row">${ICONS.map((icon) => nativeIcon(icon, size)).join('')}</div>`,
    )
    .join('');

  return `
    <main class="r143-probe">
      <section class="probe-section probe-buttons">
        <div class="probe-title">R2.03 · nút chef-ui (Tab đi qua nút, nút vô hiệu bỏ qua)</div>
        <div class="probe-button-row">
          <button id="probe-primary" class="btn btn--primary">Primary</button>
          <button class="btn btn--secondary">Secondary</button>
          <button class="btn btn--ghost">Ghost</button>
          <button class="btn btn--danger">Danger</button>
          <button class="btn btn--secondary" disabled>Vô hiệu</button>
          <button class="icon-btn icon-btn--sm" aria-label="Sao chép">${nativeIcon('copy', 16)}</button>
        </div>
      </section>
      <section class="probe-section probe-font">
        <div class="probe-title">R1.13 · font 13 px (400, 500, 600)</div>
        <div class="font-400">400: Thanh toán được</div>
        <div class="font-500">500: Thanh toán được</div>
        <div class="font-600">600: Thanh toán được</div>
        <div>Nghị định 123/2024/NĐ-CP · Đ đ Ư ư Ơ ơ · ẮẰẲẴẶ ệ ộ ự</div>
      </section>
      <section class="probe-section probe-icons">
        <div class="probe-title">R1.15 · icon 16 px và 18 px (currentColor)</div>
        ${iconRows}
      </section>
      <section class="probe-section probe-shadow">
        <div class="probe-title">R1.16 · bóng --shadow-md và vòng focus</div>
        <div class="shadow-sample"></div><div class="focus-sample"></div>
      </section>
      <section class="probe-section probe-layout">
        <div class="probe-title">R1.17 · auto-fit: ${columns} cột ở khung ${width} px</div>
        <div class="probe-grid" style="grid-template-columns:repeat(${columns},minmax(0,1fr))">${cards}</div>
        <div class="probe-ellipsis">Chuỗi rất dài cần cắt một dòng với dấu ba chấm ở cuối</div>
        <div class="probe-split">
          <div class="probe-split-left">Cột trái co lại được, chữ dài bị cắt bằng ellipsis khi khung hẹp</div>
          <div class="probe-split-right">Cột phải 300 px</div>
        </div>
        <div class="probe-ratio">260 × 100</div>
      </section>
    </main>`;
}

const PROBE_STYLE = `
  #native-probe-overlay{position:fixed;inset:0;z-index:2147483647;overflow:auto;background:var(--c-bg);color:var(--c-text);font:13px/1.5 var(--font-sans)}
  .r143-probe{box-sizing:border-box;min-height:100%;padding:24px;display:flex;flex-direction:column;gap:16px}
  .probe-section{box-sizing:border-box;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:8px}
  .probe-title{font-size:11px;color:var(--c-text-2)}
  .probe-font{font-size:13px}
  .font-400{font-weight:400}.font-500{font-weight:500}.font-600{font-weight:600}
  .probe-icon-row{display:flex;align-items:center;gap:12px;color:var(--c-text)}
  .probe-icon{display:block;flex:none;color:var(--c-text)}
  .probe-shadow{flex-direction:row;align-items:center;gap:32px}
  .shadow-sample,.focus-sample{box-sizing:border-box;width:120px;height:60px;border-radius:8px;background:var(--c-surface)}
  .shadow-sample{box-shadow:var(--shadow-md)}
  .focus-sample{border:1px solid var(--c-border);box-shadow:var(--focus-ring)}
  .probe-button-row{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
  .probe-button-row .btn{cursor:pointer}
  .probe-button-row .icon-btn{cursor:pointer}
  .probe-button-row button:disabled{cursor:default}
  .probe-grid{display:grid;gap:12px}
  .probe-card{height:40px;box-sizing:border-box;padding:0 8px;display:flex;align-items:center;background:var(--c-bg);border:1px solid var(--c-border);border-radius:6px}
  .probe-ellipsis{width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .probe-split{display:flex;gap:12px;min-width:0}
  .probe-split-left{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .probe-split-right{flex:none;width:300px;background:var(--c-bg)}
  .probe-ratio{box-sizing:border-box;width:260px;aspect-ratio:2.6;background:var(--c-bg);border:1px solid var(--c-border)}
`;

async function closeApp(launched: Launched): Promise<void> {
  const proc = launched.app.process();
  await Promise.race([launched.app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

test.skip(
  !uiBuilt || process.env.CAPTURE_NATIVE_PROBE_REFS !== '1',
  'Set CAPTURE_NATIVE_PROBE_REFS=1 after the Electron UI is built to capture references.',
);
test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const temp = os.tmpdir();
  if (isInside(OUT_DIR, repoRoot) || isInside(OUT_DIR, temp)) {
    throw new Error(
      `NATIVE_PROBE_REFS_OUT must be outside the repository and temp directory: ${OUT_DIR}`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Electron probe reference output: ${OUT_DIR}`);
});

test.afterAll(() => {
  if (captures.length === 0) return;
  const index = {
    source: 'Chef PDF Electron visual reference for native R1.43 probes',
    generatedAt: new Date().toISOString(),
    captures,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'capture-index.json'), JSON.stringify(index, null, 2) + '\n');
  fs.writeFileSync(
    MANIFEST_FILE,
    JSON.stringify(
      {
        app: 'Chef PDF Electron 1.3.0 visual reference for native R1.43 probes',
        captures,
      },
      null,
      2,
    ) + '\n',
  );
});

for (const dpr of DPRS) {
  test(`Electron probe references at DPR ${dpr}`, async () => {
    const launched = await launchApp({ args: [`--force-device-scale-factor=${dpr}`] });
    try {
      await launched.page.waitForFunction(() => typeof window.chef === 'object');
      await launched.page.evaluate(() => document.fonts.ready.then(() => undefined));

      for (const width of WIDTHS) {
        await launched.page.setViewportSize({ width, height: HEIGHT });
        await launched.page.evaluate(
          ({ theme, markup, style }) => {
            document.documentElement.dataset.theme = theme;
            document.getElementById('native-probe-overlay')?.remove();
            const css = document.createElement('style');
            css.id = 'native-probe-style';
            css.textContent = style;
            document.head.append(css);
            const overlay = document.createElement('div');
            overlay.id = 'native-probe-overlay';
            overlay.innerHTML = markup;
            document.body.append(overlay);
          },
          { theme: 'light', markup: visualProbeMarkup(width), style: PROBE_STYLE },
        );
        await launched.page.evaluate(() => document.fonts.ready.then(() => undefined));

        for (const theme of THEMES) {
          await launched.page.emulateMedia({ colorScheme: theme });
          await launched.page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
            (document.activeElement as HTMLElement | null)?.blur();
          }, theme);
          await launched.page.mouse.move(0, 0);
          await launched.page.waitForTimeout(100);
          const name = `probe_${theme}_w${width}_dpr${String(dpr).replace('.', '_')}.png`;
          const target = path.join(OUT_DIR, name);
          await launched.page.screenshot({ path: target });
          const bytes = fs.readFileSync(target);
          const size = pngSize(bytes);
          const info = await launched.page.evaluate(() => ({
            devicePixelRatio: window.devicePixelRatio,
            width: window.innerWidth,
            height: window.innerHeight,
          }));
          expect(Math.abs(info.devicePixelRatio - dpr)).toBeLessThan(0.01);
          expect(info.width).toBe(width);
          expect(info.height).toBe(HEIGHT);
          captures.push({
            file: name,
            theme,
            logicalWidth: info.width,
            logicalHeight: info.height,
            dpr,
            devicePixelRatio: info.devicePixelRatio,
            ...size,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          });
        }
      }
    } finally {
      await closeApp(launched);
    }
  });
}
