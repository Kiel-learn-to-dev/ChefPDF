/**
 * Certificates and tokens end to end (T3.02-T3.04): built UI + Electron shell + the REAL core.
 * Requires `pnpm --filter @chef/ui build` and `uv`. Skipped automatically when the UI is not built.
 *
 * The file dialog is stubbed in the Electron main process, so the tests pick the fixture files
 * without a native window. The .pfx is generated here with the core's `cryptography` package.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'certs');
const PFX_PASSWORD = 'chef-test-pw';

/** Writes `chu-ky.pfx` (password PFX_PASSWORD) and `doc.pdf` into the directory in argv[1]. */
const MAKE_FIXTURES = `
import datetime as dt, sys
from pathlib import Path
import pikepdf
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

out = Path(sys.argv[1])
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
data = pkcs12.serialize_key_and_certificates(
    b'chu-ky', key, cert, None, serialization.BestAvailableEncryption(b'${PFX_PASSWORD}')
)
(out / 'chu-ky.pfx').write_bytes(data)

pdf = pikepdf.new()
pdf.add_blank_page(page_size=(612, 792))
pdf.save(out / 'doc.pdf')
print('ok')
`;

let fixtures = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

test.beforeAll(() => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-certs-'));
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

/** Opens the fixture document and the certificate manager from the "Ký & Bảo mật" tab. */
async function openCertManager(): Promise<Launched> {
  launched = await launchApp({
    args: [path.join(fixtures, 'doc.pdf')],
    env: { CHEF_CORE_CMD: realCoreCmd },
  });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });
  await l.page.waitForSelector('.pdfViewer .page canvas', { timeout: 30_000 });
  await l.page.click('.ftab >> text=Ký & Bảo mật');
  await l.page.click('.toolbar__btn:has-text("Chứng thư & token")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Chứng thư & token');
  return l;
}

/** Makes the next file dialog return `filePath` (main process stub). */
async function stubOpenDialog(l: Launched, filePath: string): Promise<void> {
  await l.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, filePath);
}

test('reads a .pfx certificate, reports a wrong password in Vietnamese, and shows the card', async () => {
  const l = await openCertManager();
  const pfx = path.join(fixtures, 'chu-ky.pfx');
  await stubOpenDialog(l, pfx);
  await l.page.click('.certs__pick button:has-text("Chọn file chứng thư")');
  await expect(l.page.locator('.certs__file')).toHaveText('chu-ky.pfx');

  await l.page.fill('#pfx-password', 'sai-mat-khau');
  await l.page.click('.certs__section >> button:has-text("Đọc chứng thư")');
  await expect(l.page.locator('.certs__error')).toContainText('Mật khẩu file chứng thư không đúng');
  await expect(l.page.locator('.cert-card')).toHaveCount(0);

  await l.page.fill('#pfx-password', PFX_PASSWORD);
  await l.page.click('.certs__section >> button:has-text("Đọc chứng thư")');
  await expect(l.page.locator('.cert-card__name')).toHaveText('Nguyễn Văn An');
  await expect(l.page.locator('.cert-card')).toContainText('Công ty Thử nghiệm');
  await expect(l.page.locator('.certs__saved-label').first()).toHaveText('chu-ky.pfx');
  await l.page.screenshot({ path: path.join(shotsDir, 'pfx-card.png') });
});

test('remembers the password with safeStorage: the file on disk does not contain it', async () => {
  const l = await openCertManager();
  const available = await l.page.evaluate(() => window.chef.secrets.available());
  test.skip(!available, 'OS secure storage is not available on this machine');

  const pfx = path.join(fixtures, 'chu-ky.pfx');
  await stubOpenDialog(l, pfx);
  await l.page.click('.certs__pick button:has-text("Chọn file chứng thư")');
  await l.page.fill('#pfx-password', PFX_PASSWORD);
  await l.page.getByRole('checkbox', { name: /Ghi nhớ mật khẩu/ }).click();
  await l.page.click('.certs__section >> button:has-text("Đọc chứng thư")');
  await expect(l.page.locator('.cert-card__name')).toHaveText('Nguyễn Văn An');
  await expect(l.page.locator('.certs__saved-item').first()).toContainText('Đã nhớ mật khẩu');

  const secretsFile = path.join(l.userDataDir, 'secrets.json');
  await expect.poll(() => fs.existsSync(secretsFile)).toBe(true);
  expect(fs.readFileSync(secretsFile, 'utf8')).not.toContain(PFX_PASSWORD);
  const remembered = await l.page.evaluate((p) => window.chef.secrets.get(p), pfx);
  expect(remembered).toBe(PFX_PASSWORD);
  await l.page.screenshot({ path: path.join(shotsDir, 'pfx-remembered.png') });
});

test('scans for token drivers and runs the diagnostic wizard to the end', async () => {
  const l = await openCertManager();
  await l.page.click('.segmented__item:has-text("USB token")');
  await l.page.click('.certs__actions button:has-text("Quét tìm driver")');
  // The catalogue always lists drivers; those not installed are shown as "Chưa có".
  await expect(l.page.locator('.driver-row').first()).toBeVisible({ timeout: 60_000 });
  expect(await l.page.locator('.driver-row').count()).toBeGreaterThan(0);
  await l.page.screenshot({ path: path.join(shotsDir, 'drivers.png') });

  await l.page.click('.certs__actions button:has-text("Chẩn đoán token")');
  await expect(l.page.locator('.dlg__title').last()).toHaveText('Chẩn đoán token', {
    timeout: 60_000,
  });
  await expect(l.page.locator('.diag-step')).toHaveCount(8, { timeout: 60_000 });
  await expect(l.page.locator('.diag-step').first()).toBeVisible();
  await l.page.screenshot({ path: path.join(shotsDir, 'wizard.png') });
});
