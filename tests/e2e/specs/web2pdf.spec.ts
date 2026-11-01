/**
 * Web / Markdown / HTML to PDF end to end (T5.06): built UI + Electron shell + the REAL core.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 *
 * The file dialog is stubbed in the Electron main process so that the fixture file is granted the
 * same way as a file the user picked. The output is read back with pypdfium2 from the core's
 * Python environment. No remote page is loaded: the network is not needed for these checks.
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

const EXTRACT = `
import json, sys
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(sys.argv[1])
text = ''.join(pdf[i].get_textpage().get_text_range() for i in range(len(pdf)))
print(json.dumps({'pages': len(pdf), 'text': text}))
`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-web2pdf-'));
const extractScript = path.join(workDir, 'extract.py');
const mdPath = path.join(workDir, 'ghi-chu.md');
const htmlPath = path.join(workDir, 'trang.html');

let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  fs.writeFileSync(extractScript, EXTRACT, 'utf8');
  fs.writeFileSync(
    mdPath,
    [
      '# Biên bản họp',
      '',
      'Xin chào, **đây là** tài liệu thử nghiệm của *Chef PDF*.',
      '',
      '- Hạng mục một',
      '- Hạng mục hai với `mã lệnh`',
      '',
      '<script>document.title = "pwned"</script>',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    htmlPath,
    '<!doctype html><html><head><meta charset="utf-8"><title>Trang thử</title>' +
      '<script>document.body.innerHTML = "BI HUY"</script></head>' +
      '<body><p>Nội dung an toàn của trang HTML.</p></body></html>',
    'utf8',
  );
});

test.afterEach(async () => {
  const l = launched;
  launched = null;
  if (!l) return;
  const proc = l.app.process();
  await Promise.race([l.app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

test.afterAll(() => {
  removeTempDirs();
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Text and page count of a PDF, read by the core's pypdfium2. */
function pdfText(file: string): { pages: number; text: string } {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-I', extractScript, file],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return JSON.parse(out) as { pages: number; text: string };
}

/** Makes the next open dialog return `file`, then lets the renderer pick it (grants the file). */
async function grantFile(l: Launched, file: string): Promise<void> {
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never;
  }, file);
  await l.page.evaluate(() => window.chef.files.openDialog({ multiple: false }));
}

test('converts a Markdown file with Vietnamese text to a PDF that contains the text', async () => {
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await grantFile(l, mdPath);
  const out = path.join(workDir, 'ghi-chu.pdf');

  const result = await l.page.evaluate((args) => window.chef.convert.toPdf(args), {
    kind: 'file',
    source: mdPath,
    outputPath: out,
    options: { pageSize: 'A4' },
  } as never);

  expect(result).toMatchObject({ outputPath: out });
  const bytes = fs.readFileSync(out);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const doc = pdfText(out);
  expect(doc.pages).toBeGreaterThanOrEqual(1);
  expect(doc.text).toContain('Xin chào');
  expect(doc.text).toContain('Hạng mục hai');
  // The script in the Markdown is shown as plain text (escaped), not as markup.
  expect(doc.text).toContain('<script>');
  expect(doc.text).toContain('document.title');
});

test('prints a local HTML page without running its scripts', async () => {
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await grantFile(l, htmlPath);
  const out = path.join(workDir, 'trang.pdf');

  await l.page.evaluate((args) => window.chef.convert.toPdf(args), {
    kind: 'file',
    source: htmlPath,
    outputPath: out,
  } as never);

  const doc = pdfText(out);
  expect(doc.text).toContain('Nội dung an toàn');
  expect(doc.text).not.toContain('BI HUY');
});

test('refuses a remote page that the user did not confirm, and a file it did not grant', async () => {
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  const outUrl = path.join(workDir, 'web.pdf');
  const remote = await l.page.evaluate(
    (args) =>
      window.chef.convert.toPdf(args).then(
        () => 'ok',
        (e: Error) => String(e?.message ?? e),
      ),
    { kind: 'url', source: 'https://example.com/', outputPath: outUrl, confirmed: false } as never,
  );
  expect(remote).toMatch(/confirm/i);
  expect(fs.existsSync(outUrl)).toBe(false);

  const ungranted = await l.page.evaluate(
    (args) =>
      window.chef.convert.toPdf(args).then(
        () => 'ok',
        (e: Error) => String(e?.message ?? e),
      ),
    { kind: 'file', source: path.join(workDir, 'khong-duoc-cap.md'), outputPath: outUrl } as never,
  );
  expect(ungranted).toMatch(/picked|not found|FILE_NOT_/i);
});
