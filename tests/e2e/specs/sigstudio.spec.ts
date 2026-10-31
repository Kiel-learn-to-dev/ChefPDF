/**
 * Signature panel, template studio and image library end to end (T3.08 UI, T3.10, T3.11 UI):
 * built UI + Electron shell + the REAL core. Requires `pnpm --filter @chef/ui build` and `uv`.
 * Skipped automatically when the UI is not built.
 *
 * The file dialog is stubbed in the Electron main process. The signed PDF is made by the core's
 * own sign.pades operation (no session), the ink image by Pillow in the same environment.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'sigstudio');
const PFX_PASSWORD = 'chef-test-pw';
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Writes doc.pdf (blank), signed.pdf (signed with sign.pades), chu-ky.pfx and ink.png into argv[1]. */
const MAKE_FIXTURES = `
import datetime as dt, sys
from pathlib import Path
import pikepdf
from PIL import Image, ImageDraw
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op

load_builtin_ops()
out = Path(sys.argv[1])
pw = b'${PFX_PASSWORD}'
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
(out / 'chu-ky.pfx').write_bytes(
    pkcs12.serialize_key_and_certificates(b'chu-ky', key, cert, None, serialization.BestAvailableEncryption(pw))
)
pdf = pikepdf.new()
pdf.add_blank_page(page_size=(612, 792))
pdf.save(out / 'doc.pdf')
pdf.save(out / 'unsigned.pdf')

spec = get_op('sign.pades')
params = spec.params_model.model_validate({
    'pfxPath': str(out / 'chu-ky.pfx'), 'password': pw.decode(), 'level': 'B-B',
    'page': 0, 'rect': [60, 60, 260, 120], 'reason': 'Phê duyệt',
})
ctx = OpContext(job_id='e2e', work_dir=out, input_path=out / 'unsigned.pdf', result_path=out / 'signed.pdf')
spec.run(ctx, params)

img = Image.new('RGB', (420, 160), (246, 244, 236))
draw = ImageDraw.Draw(img)
draw.line([(40, 110), (120, 40), (160, 120), (240, 50), (330, 110)], fill=(20, 30, 120), width=5)
img.save(out / 'ink.png')
print('ok')
`;

let fixtures = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-sigstudio-'));
  execFileSync('uv', ['run', '--project', coreDir, 'python', '-c', MAKE_FIXTURES, fixtures], {
    cwd: repoRoot,
  });
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

/** Opens a PDF with the real core and switches to the "Ký & Bảo mật" tab. */
async function openWithSignTab(file: string): Promise<Launched> {
  launched = await launchApp({
    args: [path.join(fixtures, file)],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Ký & Bảo mật');
  return l;
}

/** Makes the next file dialog return `filePath` (main process stub). */
async function stubOpenDialog(l: Launched, filePath: string): Promise<void> {
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, filePath);
}

test('the signature panel lists the signer and a status badge for a signed PDF', async () => {
  const l = await openWithSignTab('signed.pdf');
  await l.page.locator('.toolbar__btn', { hasText: /^Chữ ký$/ }).click();

  const item = l.page.locator('.sig-item').first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  // The core names the signer from the certificate: the organisation when there is no person field.
  await expect(item.locator('.sig-item__who')).toHaveText('Công ty Thử nghiệm');
  await expect(item.locator('.sig-badge')).toBeVisible();
  await expect(item.locator('.sig-badge')).toHaveAttribute(
    'data-status',
    /^(valid|valid-with-warnings|unknown|invalid)$/,
  );
  await expect(l.page.locator('.status__chip')).toBeVisible();

  await item.locator('.sig-item__toggle').click();
  await expect(l.page.locator('.sig-detail')).toContainText('Chuỗi chứng thư');
  await l.page.screenshot({ path: path.join(shotsDir, 'panel.png') });
});

test('a template edited in the studio is saved and comes back after reopening', async () => {
  const l = await openWithSignTab('doc.pdf');
  await l.page.click('.toolbar__btn:has-text("Mẫu chữ ký")');
  await expect(l.page.locator('.dlg__title').last()).toHaveText('Mẫu chữ ký');

  await l.page.fill('#tpl-name', 'Mẫu E2E');
  await l.page.fill('#tpl-header', 'Ký bởi (e2e)');
  await l.page.locator('.tpl__line input[aria-label="Nhãn"]').first().fill('Người ký:');
  await l.page.click('.dlg__footer button:has-text("Lưu mẫu")');
  await expect(l.page.locator('.tpl__notice')).toHaveText('Đã lưu mẫu.');

  const stored = await l.page.evaluate(() => window.chef.settings.get());
  expect(stored.signTemplates.map((e) => e.name)).toContain('Mẫu E2E');
  await l.page.screenshot({ path: path.join(shotsDir, 'studio.png') });

  await l.page.keyboard.press('Escape');
  await expect(l.page.locator('.dlg__title')).toHaveCount(0);
  await l.page.click('.toolbar__btn:has-text("Mẫu chữ ký")');

  await expect(l.page.locator('.tpl__item-name', { hasText: 'Mẫu E2E' })).toBeVisible();
  await l.page.locator('.tpl__item', { hasText: 'Mẫu E2E' }).click();
  await expect(l.page.locator('#tpl-header')).toHaveValue('Ký bởi (e2e)');
  await expect(l.page.locator('.tpl__line input[aria-label="Nhãn"]').first()).toHaveValue(
    'Người ký:',
  );
});

test('the library encrypts an image added from a file and never writes its PNG bytes', async () => {
  const l = await openWithSignTab('doc.pdf');
  const available = await l.page.evaluate(() => window.chef.library.status());
  await l.page.click('.toolbar__btn:has-text("Thư viện ảnh")');
  await expect(l.page.locator('.dlg__title').last()).toHaveText('Thư viện chữ ký & con dấu');

  if (!available.encrypted) {
    // No OS secure storage here: the library must say so instead of hiding it.
    await expect(l.page.locator('.lib__warning')).toBeVisible();
    test.skip(true, 'OS secure storage is not available on this machine');
    return;
  }

  await stubOpenDialog(l, path.join(fixtures, 'ink.png'));
  await l.page.click('.lib__add button:has-text("Từ file ảnh")');
  await l.page.click('.lib-flow__pick button');

  // Background removal and clean-up run in the real core; the result appears on the checkerboard.
  await expect(l.page.locator('.lib-compare__pane--checker img')).toBeVisible({ timeout: 60_000 });
  await l.page.screenshot({ path: path.join(shotsDir, 'library-preview.png') });

  await l.page.fill('.lib-save input', 'Chữ ký thử');
  await l.page.click('.lib-save__buttons button:has-text("Lưu vào thư viện")');
  await expect(l.page.locator('.lib-card')).toHaveCount(1, { timeout: 30_000 });
  await expect(l.page.locator('.lib-card__name')).toHaveText('Chữ ký thử');

  const dir = path.join(l.userDataDir, 'library');
  const sealed = fs.readdirSync(dir).filter((f) => f.endsWith('.enc'));
  expect(sealed).toHaveLength(1);
  const bytes = fs.readFileSync(path.join(dir, sealed[0]!));
  expect(bytes.includes(PNG_HEADER)).toBe(false);
  // The index keeps the name only, never image data.
  expect(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).toContain('Chữ ký thử');
});
