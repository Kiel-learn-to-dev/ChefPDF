"""Generates the inputs of demo-v09 (docs/TASKS.md v0.9) — run with the core environment.

Usage: python demo_v09_corpus.py OUT_DIR

Writes:
- ho-so/ho-so-01.pdf .. ho-so-20.pdf: 20 Vietnamese two-page PDFs, the dossier the "Nộp hồ sơ online"
  preset merges (one result for the whole batch).
- ra-word/: three good PDFs and hong.pdf, which is not a PDF at all (one bad file in a batch).
- chu-ky.pfx (password DEMO_PASSWORD) and chu-ky-cert.der: a throwaway self-signed certificate,
  plus its certificate as the trust root for the check (demo_v09_check.py).
"""

import datetime
import sys
from pathlib import Path

import chef_core
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

DEMO_PASSWORD = "demo-v09-pass"
FONT_DIR = Path(chef_core.__file__).parent / "resources" / "fonts"
pdfmetrics.registerFont(TTFont("TxtBeVN", str(FONT_DIR / "BeVietnamPro-Regular.ttf")))
pdfmetrics.registerFont(TTFont("TxtBeVNBold", str(FONT_DIR / "BeVietnamPro-Bold.ttf")))

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)


def write_pdf(path: Path, number: int) -> None:
    cv = canvas.Canvas(str(path), pagesize=(612, 792))
    for page in (1, 2):
        cv.setFont("TxtBeVNBold", 14)
        cv.drawString(72, 600, f"Hồ sơ số {number:02d} — trang {page}")
        cv.setFont("TxtBeVN", 11)
        cv.drawString(72, 580, f"Đề nghị cấp giấy tờ, hồ sơ thứ {number:02d}, trang {page} trên hai trang.")
        cv.drawString(72, 560, "Kính gửi: Phòng Hành chính. Mọi thông tin trong hồ sơ là đúng sự thật.")
        cv.showPage()
    cv.save()


dossier = out / "ho-so"
dossier.mkdir(exist_ok=True)
for number in range(1, 21):
    write_pdf(dossier / f"ho-so-{number:02d}.pdf", number)

batch = out / "ra-word"
batch.mkdir(exist_ok=True)
for number in range(1, 4):
    write_pdf(batch / f"van-ban-{number}.pdf", number)
(batch / "hong.pdf").write_bytes(b"day khong phai la file PDF\n")

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name(
    [
        x509.NameAttribute(NameOID.COMMON_NAME, "Demo v0.9 Signer"),
        x509.NameAttribute(NameOID.COUNTRY_NAME, "VN"),
    ]
)
now = datetime.datetime.now(datetime.timezone.utc)
cert = (
    x509.CertificateBuilder()
    .subject_name(name)
    .issuer_name(name)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(days=1))
    .not_valid_after(now + datetime.timedelta(days=365))
    .add_extension(
        x509.KeyUsage(
            digital_signature=True,
            content_commitment=True,
            key_encipherment=False,
            data_encipherment=False,
            key_agreement=False,
            key_cert_sign=False,
            crl_sign=False,
            encipher_only=False,
            decipher_only=False,
        ),
        critical=True,
    )
    .sign(key, hashes.SHA256())
)
(out / "chu-ky.pfx").write_bytes(
    pkcs12.serialize_key_and_certificates(
        b"demo-v09",
        key,
        cert,
        None,
        serialization.BestAvailableEncryption(DEMO_PASSWORD.encode()),
    )
)
(out / "chu-ky-cert.der").write_bytes(cert.public_bytes(serialization.Encoding.DER))
print("ok")
