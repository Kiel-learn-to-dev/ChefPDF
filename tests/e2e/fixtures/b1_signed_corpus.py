"""Inputs of the in-session B1 test: a signed PDF made from contract.pdf with a throwaway certificate.

Usage (core environment): python -I b1_signed_corpus.py SRC_PDF OUT_DIR

Writes OUT_DIR/signed.pdf (SRC_PDF with one PAdES signature, the certificate is a throwaway
self-signed one). The signed file is the only input; SRC_PDF is not changed.
"""

import datetime
import shutil
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers

PASSWORD = b"b1-throwaway"


def make_pfx(path: Path) -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Chef B1 test signer")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
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
    path.write_bytes(
        pkcs12.serialize_key_and_certificates(
            b"b1-signer",
            key,
            cert,
            None,
            serialization.BestAvailableEncryption(PASSWORD),
        )
    )


def main() -> None:
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    pfx = out_dir / "b1-signer.p12"
    make_pfx(pfx)
    signed = out_dir / "signed.pdf"
    shutil.copyfile(src, signed)
    signer = signers.SimpleSigner.load_pkcs12(str(pfx), passphrase=PASSWORD)
    meta = signers.PdfSignatureMetadata(field_name="Signature1", reason="B1 test")
    with signed.open("rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        out = signers.sign_pdf(writer, meta, signer=signer)
        data = out.getvalue()
    signed.write_bytes(data)
    print(f"ok {signed}")


if __name__ == "__main__":
    main()
