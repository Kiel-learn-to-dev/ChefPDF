/**
 * Signing workflow end to end (T3.12 placement, T3.13 batch): built UI + Electron shell + the REAL
 * core. Requires `pnpm --filter @chef/ui build` and `uv`. Skipped when the UI is not built.
 *
 * The file dialog is stubbed in the main process (a queue of answers, one per dialog). Fixtures
 * (PFX, PDFs with the Vietnamese anchor text) are made by the core's own Python environment; the
 * results are read back with the core's ops (sign.listFields, sign.verifyFile), not with the UI.
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
const shotsDir = path.join(repoRoot, 'tests', 'e2e', 'test-results', 'signflow');
const PFX_PASSWORD = 'chef-test-pw';
const FONT = path.join(repoRoot, 'tests', 'corpus', 'fonts', 'BeVietnamPro-Regular.ttf');
const SIGNED_STATUSES = ['valid', 'valid-with-warnings', 'unknown'];

/**
 * Writes: chu-ky.pfx; giam-doc.pdf (A4, "GIÁM ĐỐC" under a line of text); trang-trong.pdf (blank
 * A4); batch/hop-dong-1..3.pdf (the same text, for batch signing). Font: Be Vietnam Pro.
 */
const MAKE_FIXTURES = `
import datetime as dt, sys
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
font = sys.argv[2]
pdfmetrics.registerFont(TTFont('BeVietnamPro', font))

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
    pkcs12.serialize_key_and_certificates(
        b'chu-ky', key, cert, None, serialization.BestAvailableEncryption(b'${PFX_PASSWORD}')
    )
)

def make(path, anchor):
    c = canvas.Canvas(str(path), pagesize=A4)
    if anchor:
        c.setFont('BeVietnamPro', 12)
        c.drawString(90, 420, 'Hà Nội, ngày 01 tháng 11 năm 2026')
        c.setFont('BeVietnamPro', 13)
        c.drawString(90, 340, 'GIÁM ĐỐC')
    c.showPage()
    c.save()

(out / 'batch').mkdir(exist_ok=True)
make(out / 'giam-doc.pdf', True)
make(out / 'trang-trong.pdf', False)
for i in (1, 2, 3):
    make(out / 'batch' / f'hop-dong-{i}.pdf', True)
print('ok')
`;

/**
 * Runs one core op on a file and prints its `data` as JSON (last stdout line).
 */
const INSPECT = `
import json, sys
from pathlib import Path
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op

load_builtin_ops()
op_id, file, params_json = sys.argv[1], sys.argv[2], sys.argv[3]
spec = get_op(op_id)
params = spec.params_model.model_validate(json.loads(params_json))
ctx = OpContext(job_id='e2e', work_dir=Path(file).parent, input_path=Path(file), result_path=None)
result = spec.run(ctx, params)
print(json.dumps(result.data, default=str))
`;

let fixtures = '';
let launched: Launched | null = null;

test.describe.configure({ mode: 'serial' });
test.skip(!uiBuilt, 'UI not built (run pnpm --filter @chef/ui build)');

/** Calls a core op on a file with the core's own Python environment. */
function core(opId: string, file: string, params: Record<string, unknown> = {}): unknown {
  const out = execFileSync(
    'uv',
    ['run', '--project', coreDir, 'python', '-c', INSPECT, opId, file, JSON.stringify(params)],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop() ?? 'null');
}

test.beforeAll(() => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-signflow-'));
  execFileSync('uv', ['run', '--project', coreDir, 'python', '-c', MAKE_FIXTURES, fixtures, FONT], {
    cwd: repoRoot,
    stdio: 'inherit',
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

/** Makes the next file dialogs return the given answers, one per dialog, in order. */
async function stubPicks(l: Launched, answers: string[][]): Promise<void> {
  await l.app.evaluate(({ dialog }, list) => {
    let i = 0;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list[i++] ?? [] });
  }, answers);
}

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

/** Chooses the certificate file and reads it (the password is typed, not stored). */
async function chooseCertificate(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Chọn file .pfx / .p12', exact: true }).click();
  await page.fill('#sign-pfx-password', PFX_PASSWORD);
  await page.getByRole('button', { name: 'Đọc chứng thư', exact: true }).click();
  await expect(page.locator('.cert-card').first()).toBeVisible({ timeout: 30_000 });
}

test('signs by anchor text at level B-B and the signatures panel lists the signer', async () => {
  const l = await openWithSignTab('giam-doc.pdf');
  await stubPicks(l, [[path.join(fixtures, 'chu-ky.pfx')]]);
  await l.page.click('.toolbar__btn:has-text("Ký tài liệu")');
  await expect(l.page.locator('.dlg__title')).toHaveText('Ký tài liệu');

  await chooseCertificate(l.page);
  await l.page.getByRole('button', { name: 'Theo chữ mốc', exact: true }).click();
  await l.page.fill('#sign-anchor-text', 'GIÁM ĐỐC');
  await l.page.getByRole('button', { name: 'Xem trước', exact: true }).click();
  await expect(l.page.locator('.dlg')).toContainText('Tìm thấy 1 chỗ.', { timeout: 30_000 });
  await expect(l.page.locator('[data-testid="anchor-preview"]').first()).toBeVisible();

  await l.page.getByRole('button', { name: 'Ký', exact: true }).click();
  await expect(l.page.locator('.dlg__title', { hasText: 'Ký tài liệu' })).toHaveCount(0, {
    timeout: 90_000,
  });

  const item = l.page.locator('.sig-item').first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await expect(item.locator('.sig-badge')).toHaveAttribute(
    'data-status',
    /^(valid|valid-with-warnings|unknown)$/,
    { timeout: 60_000 },
  );
  await l.page.screenshot({ path: path.join(shotsDir, 'anchor-signed.png') });

  // Save in place: an unsaved document would raise the native "leave site" prompt on close.
  const file = path.join(fixtures, 'giam-doc.pdf');
  await l.page.keyboard.press('Control+s');
  await expect
    .poll(
      () => {
        const fields = core('sign.listFields', file) as { fields: { signed: boolean }[] };
        return fields.fields.filter((f) => f.signed).length;
      },
      { timeout: 60_000 },
    )
    .toBe(1);
});

test('draws a box with the mouse and the signature lands in that rectangle', async () => {
  const file = path.join(fixtures, 'drawn.pdf');
  fs.copyFileSync(path.join(fixtures, 'trang-trong.pdf'), file);
  const l = await openWithSignTab('drawn.pdf');
  await l.page.click('.toolbar__btn:has-text("Đặt ô ký")');
  await expect(l.page.getByTestId('placement-layer')).toHaveClass(/sign-layer--place/);

  const canvas = await l.page.locator('.pdfViewer .page canvas').first().boundingBox();
  expect(canvas).not.toBeNull();
  const x = canvas!.x + canvas!.width * 0.2;
  const y = canvas!.y + canvas!.height * 0.6;
  await l.page.mouse.move(x, y);
  await l.page.mouse.down();
  await l.page.mouse.move(x + 220, y + 70, { steps: 10 });
  await l.page.mouse.up();
  await expect(l.page.getByTestId('placement-box')).toBeVisible();

  await stubPicks(l, [[path.join(fixtures, 'chu-ky.pfx')]]);
  await l.page.getByRole('button', { name: 'Ký ở đây', exact: true }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Ký tài liệu');
  await chooseCertificate(l.page);
  await l.page.getByRole('button', { name: 'Ký', exact: true }).click();
  await expect(l.page.locator('.dlg__title', { hasText: 'Ký tài liệu' })).toHaveCount(0, {
    timeout: 90_000,
  });

  // Save in place (Ctrl+S) and check the saved file with the core.
  await l.page.keyboard.press('Control+s');
  await expect
    .poll(
      () => {
        const fields = core('sign.listFields', file) as {
          fields: { rect: number[] | null; signed: boolean }[];
        };
        return fields.fields.filter((f) => f.signed).length;
      },
      { timeout: 60_000 },
    )
    .toBe(1);

  const fields = core('sign.listFields', file) as {
    fields: { page: number; rect: number[]; signed: boolean }[];
  };
  const field = fields.fields[0]!;
  expect(field.page).toBe(0);
  const [x1, y1, x2, y2] = field.rect as [number, number, number, number];
  // A4 page: 595.28 x 841.89 points. The box is drawn inside it, and it is not empty.
  expect(x1).toBeGreaterThanOrEqual(0);
  expect(y1).toBeGreaterThanOrEqual(0);
  expect(x2).toBeLessThanOrEqual(595.3);
  expect(y2).toBeLessThanOrEqual(841.9);
  expect(x2 - x1).toBeGreaterThan(50);
  expect(y2 - y1).toBeGreaterThan(20);
});

test('batch-signs three PDFs with a suffix and every output verifies', async () => {
  const inputs = [1, 2, 3].map((i) => path.join(fixtures, 'batch', `hop-dong-${i}.pdf`));
  const outputs = inputs.map((p) => p.replace(/\.pdf$/, '_da-ky.pdf'));
  launched = await launchApp({ env: { CHEF_CORE_CMD: realCoreCmd } });
  const l = launched;
  await l.page.setViewportSize({ width: 1280, height: 800 });

  await stubPicks(l, [inputs, [path.join(fixtures, 'chu-ky.pfx')]]);
  await l.page.locator('.tile', { hasText: 'Ký hàng loạt' }).click();
  await expect(l.page.locator('.dlg__title')).toHaveText('Ký hàng loạt');

  await l.page.getByRole('button', { name: 'Thêm file…', exact: true }).click();
  await expect(l.page.locator('.sign-file-list li')).toHaveCount(3);

  await chooseCertificate(l.page);
  await l.page.getByRole('button', { name: /^Ký 3 file/ }).click();
  await expect(l.page.getByTestId('batch-results')).toBeVisible({ timeout: 120_000 });
  await expect(
    l.page.locator('[data-testid="batch-results"] tr[data-status="signed"]'),
  ).toHaveCount(3);
  await l.page.screenshot({ path: path.join(shotsDir, 'batch-results.png') });

  for (const out of outputs) {
    expect(fs.existsSync(out), `output ${path.basename(out)} exists`).toBe(true);
    const report = core('sign.verifyFile', out, { path: out }) as {
      signatures: { status: string }[];
    };
    expect(report.signatures.length).toBeGreaterThan(0);
    for (const sig of report.signatures) {
      expect(SIGNED_STATUSES).toContain(sig.status);
    }
  }
});
