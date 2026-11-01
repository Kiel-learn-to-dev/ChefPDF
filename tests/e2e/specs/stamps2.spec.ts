/**
 * Stamps, bookmarks, batch verification and repair end to end (M7-M11, I36, T4.07-T4.10): built UI +
 * Electron shell + the REAL core. Requires `pnpm --filter @chef/ui build` and `uv`. Skipped when the
 * UI is not built.
 *
 * File dialogs are stubbed in the main process (one answer per dialog, in order). Fixtures are made
 * by the core's own Python environment. Results are read back with the core (pikepdf, pypdfium2)
 * or from the report file itself, never from the UI.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'stamps2');
const FONT = path.join(repoRoot, 'tests', 'corpus', 'fonts', 'BeVietnamPro-Regular.ttf');
const PFX_PASSWORD = 'chef-test-pw';

/**
 * Writes into the folder given as argv[1] (font in argv[2]):
 *   ba-trang-4.pdf   four A4 pages, one line of Vietnamese text each
 *   seal.png         a red ring on a transparent background (the seal of the giáp lai test)
 *   chu-ky.pfx       a self-signed signing certificate
 *   da-ky.pdf        one page signed by the core (sign.pades)
 *   chua-ky.pdf      one page, not signed
 *   cat-cut.pdf      a four-page file (standard font) cut in two thirds (a damaged file)
 */
const MAKE_FIXTURES = `
import datetime as dt, io, sys
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op

out = Path(sys.argv[1])
pdfmetrics.registerFont(TTFont('BeVietnamPro', sys.argv[2]))

def page_pdf(path, pages, text_of):
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(1, pages + 1):
        c.setFont('BeVietnamPro', 12)
        c.drawString(72, 600, text_of(i))
        c.showPage()
    c.save()

page_pdf(out / 'ba-trang-4.pdf', 4, lambda i: f'Nội dung trang {i}')
page_pdf(out / 'chua-ky.pdf', 1, lambda i: 'Hợp đồng chưa ký')
# Cut file from a document with a standard (not embedded) font: the core rebuilds that file, but an
# embedded font cut at two thirds cannot be rebuilt (INVALID_PDF), so the fixture must avoid it.
rep = canvas.Canvas(str(out / 'cat-cut-nguon.pdf'), pagesize=A4)
for i in range(1, 5):
    rep.setFont('Helvetica', 12)
    rep.drawString(72, 600, f'Trang {i}')
    rep.showPage()
rep.save()
data = (out / 'cat-cut-nguon.pdf').read_bytes()
(out / 'cat-cut.pdf').write_bytes(data[: len(data) * 2 // 3])

img = Image.new('RGBA', (240, 240), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.ellipse((8, 8, 232, 232), outline=(200, 16, 16, 255), width=14)
draw.text((78, 104), 'CHEF', fill=(200, 16, 16, 255))
img.save(out / 'seal.png')

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([
    x509.NameAttribute(NameOID.COUNTRY_NAME, 'VN'),
    x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'Công ty Thử nghiệm'),
    x509.NameAttribute(NameOID.COMMON_NAME, 'Nguyễn Văn An'),
])
now = dt.datetime.now(dt.UTC)
cert = (
    x509.CertificateBuilder()
    .subject_name(name)
    .issuer_name(name)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - dt.timedelta(days=1))
    .not_valid_after(now + dt.timedelta(days=400))
    .add_extension(
        x509.KeyUsage(
            digital_signature=True, content_commitment=True, key_encipherment=False,
            data_encipherment=False, key_agreement=False, key_cert_sign=False,
            crl_sign=False, encipher_only=False, decipher_only=False,
        ),
        critical=True,
    )
    .sign(key, hashes.SHA256())
)
pfx = out / 'chu-ky.pfx'
pfx.write_bytes(
    pkcs12.serialize_key_and_certificates(
        b'chu-ky', key, cert, None, serialization.BestAvailableEncryption(b'${PFX_PASSWORD}')
    )
)

load_builtin_ops()
src = out / 'chua-ky-nguon.pdf'
(out / 'chua-ky.pdf').replace(src)
ctx = OpContext(job_id='e2e', work_dir=out, input_path=src, result_path=out / 'da-ky.pdf')
spec = get_op('sign.pades')
spec.run(ctx, spec.params_model.model_validate({'pfxPath': str(pfx), 'password': '${PFX_PASSWORD}'}))
src.replace(out / 'chua-ky.pdf')
print('ok')
`;

/** Pages of the saved file and the number of images on each (pikepdf, the core's environment). */
const IMAGES_PER_PAGE = `
import json, sys
import pikepdf

pdf = pikepdf.open(sys.argv[1])
print(json.dumps([len(page.images) for page in pdf.pages]))
`;

let fixtures = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-stamps2-'));
  execFileSync('uv', ['run', '--project', coreDir, 'python', '-c', MAKE_FIXTURES, fixtures, FONT], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  fs.writeFileSync(path.join(fixtures, 'images.py'), IMAGES_PER_PAGE);
  fs.mkdirSync(shotsDir, { recursive: true });
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
  fs.rmSync(fixtures, { recursive: true, force: true });
});

/** A fresh copy of a fixture, so that every test saves into its own file. */
function copyOf(source: string, name: string): string {
  const target = path.join(fixtures, name);
  fs.copyFileSync(path.join(fixtures, source), target);
  return target;
}

/** Launches the app, optionally with a file to open, and waits for the viewer or start screen. */
async function launch(args: string[] = []): Promise<Launched> {
  launched = await launchApp({ args, env: { CHEF_CORE_CMD: realCoreCmd } });
  await launched.page.setViewportSize({ width: 1280, height: 800 });
  return launched;
}

async function openDoc(file: string): Promise<Launched> {
  const l = await launch([file]);
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  return l;
}

/** Runs a command from the palette (Ctrl+K): its title typed, the first match picked. */
async function runCommand(l: Launched, title: string): Promise<void> {
  await l.page.keyboard.press('Control+k');
  await l.page.locator('.palette__input').fill(title);
  await l.page.locator('[role="option"]').first().click();
}

/** Makes the next file dialogs return the given answers, one per dialog, in order. */
async function stubPicks(l: Launched, answers: string[][]): Promise<void> {
  await l.app.evaluate(({ dialog }, list) => {
    let i = 0;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list[i++] ?? [] });
  }, answers);
}

/** Makes the next save dialog return the given path. */
async function stubSave(l: Launched, target: string): Promise<void> {
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, target);
}

/** Ctrl+S and wait until the document is no longer dirty. */
async function saveInPlace(l: Launched): Promise<void> {
  await l.page.keyboard.press('Control+s');
  await l.page.waitForFunction(() => !document.querySelector('.doctab__dirty'), null, {
    timeout: 60_000,
  });
}

function imagesPerPage(file: string): number[] {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', path.join(fixtures, 'images.py'), file],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? '[]') as number[];
}

test('(a) a text stamp from the dialog is listed as a stamp group in the overlay manager', async () => {
  const file = copyOf('ba-trang-4.pdf', 'con-dau.pdf');
  const l = await openDoc(file);
  await runCommand(l, 'Con dấu…');
  await expect(l.page.locator('.dlg__title')).toHaveText('Con dấu');
  await l.page.fill('#stamp-text', 'ĐÃ DUYỆT');
  await l.page.getByRole('button', { name: 'Đóng dấu', exact: true }).click();
  await expect(l.page.locator('.dlg__title')).toHaveCount(0, { timeout: 60_000 });

  await runCommand(l, 'Đã thêm vào tài liệu');
  await expect(l.page.locator('[data-kind="stamp"]')).toBeVisible({ timeout: 30_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'stamp-group.png') });
  // Shortcuts are ignored while a dialog is open: close the overlay manager, then save so the
  // close does not ask for confirmation.
  await l.page.keyboard.press('Escape');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0);
  await saveInPlace(l);
});

test('(b) giáp lai on 4 pages: every saved page has an image and the result shows 4 strips', async () => {
  const file = copyOf('ba-trang-4.pdf', 'giap-lai.pdf');
  const l = await openDoc(file);
  await stubPicks(l, [[path.join(fixtures, 'seal.png')]]);
  await runCommand(l, 'Dấu giáp lai…');
  await expect(l.page.locator('.dlg__title')).toHaveText('Dấu giáp lai');
  await l.page.getByRole('button', { name: 'Chọn tệp…' }).click();
  await l.page.getByRole('button', { name: 'Đóng dấu giáp lai', exact: true }).click();
  await expect(l.page.getByText('Đã đóng dấu giáp lai')).toBeVisible({ timeout: 60_000 });
  await expect(l.page.getByText(/4 dải trên 4 trang/)).toBeVisible();
  await l.page.screenshot({ path: path.join(shotsDir, 'seam-result.png') });
  await l.page.keyboard.press('Escape');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0);

  await saveInPlace(l);
  const counts = imagesPerPage(file);
  expect(counts).toHaveLength(4);
  for (const n of counts) expect(n).toBeGreaterThan(0);
});

test('(c) two bookmarks added in the editor are still there after a save and a reopen', async () => {
  const file = copyOf('ba-trang-4.pdf', 'muc-luc.pdf');
  const l = await openDoc(file);
  await l.page.locator('[aria-label="Mục lục"]').first().click();
  await l.page.getByRole('button', { name: 'Sửa mục lục', exact: true }).click();
  for (const title of ['Chương 1', 'Chương 2']) {
    await l.page.getByRole('button', { name: 'Thêm mục', exact: true }).click();
    await l.page.getByLabel('Tên mục', { exact: true }).fill(title);
  }
  await l.page.getByRole('button', { name: 'Lưu mục lục', exact: true }).click();
  await expect(l.page.getByText('Đã lưu mục lục')).toBeVisible({ timeout: 30_000 });
  await saveInPlace(l);

  await l.app.close();
  launched = null;
  const reopened = await openDoc(file);
  await reopened.page.locator('[aria-label="Mục lục"]').first().click();
  await expect(reopened.page.getByText('Chương 1', { exact: true })).toBeVisible();
  await expect(reopened.page.getByText('Chương 2', { exact: true })).toBeVisible();
});

test('(d) batch check of two files writes a CSV with two data rows', async () => {
  const signed = path.join(fixtures, 'da-ky.pdf');
  const unsigned = path.join(fixtures, 'chua-ky.pdf');
  const report = path.join(fixtures, 'bao-cao.csv');
  const l = await launch();
  await stubPicks(l, [[signed, unsigned]]);
  await stubSave(l, report);
  await runCommand(l, 'Kiểm tra chữ ký hàng loạt');
  await expect(l.page.locator('.dlg__title')).toHaveText('Kiểm tra chữ ký hàng loạt');
  await l.page.getByRole('button', { name: 'Thêm file…' }).click();
  await l.page.getByRole('button', { name: 'Chọn nơi lưu báo cáo…' }).click();
  await l.page.getByRole('button', { name: 'Kiểm tra', exact: true }).click();
  await expect(l.page.locator('.verify-result')).toBeVisible({ timeout: 90_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'verify-result.png') });

  const lines = fs
    .readFileSync(report, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  expect(lines).toHaveLength(3);
});

test('(e) repair of a cut PDF opens the repaired file', async () => {
  const damaged = copyOf('cat-cut.pdf', 'hong.pdf');
  const l = await launch();
  await stubPicks(l, [[damaged]]);
  await runCommand(l, 'Sửa file PDF hỏng');
  await expect(l.page.locator('.dlg__title')).toHaveText('Sửa file PDF hỏng');
  await l.page.getByRole('button', { name: 'Chọn file…' }).click();
  await l.page.getByRole('button', { name: 'Thử sửa file', exact: true }).click();
  await expect(l.page.locator('.doctab', { hasText: 'hong_sua.pdf' })).toBeVisible({
    timeout: 60_000,
  });
  expect(fs.existsSync(path.join(fixtures, 'hong_sua.pdf'))).toBe(true);
});
