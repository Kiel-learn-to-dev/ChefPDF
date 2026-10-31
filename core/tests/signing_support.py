"""Test PKI and local services for the signing tests.

Everything runs on 127.0.0.1 (no internet): a Root CA, an intermediate CA, several end-entity
certificates shaped like Vietnamese CA certificates (UTF-8 subject, MST/CCCD in UID attributes),
an RFC 3161 TSA, a revoked signer, and a loopback HTTP server that serves the CRLs and timestamps.
Keys are RSA-2048 and generated once per test session.
"""

from __future__ import annotations

import datetime as dt
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from asn1crypto import tsp
from asn1crypto import x509 as asn1_x509
from asn1crypto.keys import PrivateKeyInfo
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID, ObjectIdentifier
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper
from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
from pyhanko_certvalidator import ValidationContext

UID_OID = ObjectIdentifier("0.9.2342.19200300.100.1.1")
ORG_IDENTIFIER_OID = ObjectIdentifier("2.5.4.97")
NOW = dt.datetime.now(dt.UTC).replace(microsecond=0)

PASSWORD_A = "Mật-khẩu-A-2026"  # non-ASCII on purpose
PASSWORD_B = "second-pass-B-2026"
PASSWORD_EXPIRING = "expiring-2026"
PASSWORD_EXPIRED = "expired-2020"
PASSWORD_REVOKED = "revoked-2026"


class LocalServices:
    """CRL and TSA endpoints on a loopback port chosen by the OS."""

    def __init__(self) -> None:
        self.crls: dict[str, bytes] = {}
        self.tsa: DummyTimeStamper | None = None
        self.hits: dict[str, int] = {"crl": 0, "tsa": 0}
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(self))
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def _handler_for(services: LocalServices) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def _reply(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            name = self.path.removeprefix("/crl/")
            if self.path.startswith("/crl/") and name in services.crls:
                services.hits["crl"] += 1
                self._reply(200, services.crls[name], "application/pkix-crl")
                return
            self._reply(404, b"", "text/plain")

        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path == "/tsa" and services.tsa is not None:
                services.hits["tsa"] += 1
                request = tsp.TimeStampReq.load(body)
                reply = services.tsa.request_tsa_response(request).dump()
                self._reply(200, reply, "application/timestamp-reply")
                return
            self._reply(404, b"", "text/plain")

    return Handler


@dataclass(frozen=True)
class Identity:
    key: rsa.RSAPrivateKey
    cert: x509.Certificate


@dataclass(frozen=True)
class Pki:
    root: Identity
    inter: Identity
    signer_a: Identity  # password PASSWORD_A, full chain in the PFX
    signer_b: Identity  # password PASSWORD_B, full chain in the PFX
    expiring: Identity  # expires in 10 days
    expired: Identity  # expired yesterday
    revoked: Identity  # listed in the intermediate CRL
    tsa: Identity
    root_pem: Path
    directory: Path

    def pfx(
        self, name: str, identity: Identity, password: str | None, chain: list[x509.Certificate]
    ) -> Path:
        encryption: serialization.KeySerializationEncryption = (
            serialization.BestAvailableEncryption(password.encode("utf-8"))
            if password
            else serialization.NoEncryption()
        )
        data = pkcs12.serialize_key_and_certificates(
            name=name.encode("ascii"),
            key=identity.key,
            cert=identity.cert,
            cas=chain,
            encryption_algorithm=encryption,
        )
        path = self.directory / f"{name}.pfx"
        path.write_bytes(data)
        return path

    def pfx_a(self) -> Path:
        return self.pfx("signer-a", self.signer_a, PASSWORD_A, [self.inter.cert, self.root.cert])

    def pfx_b(self) -> Path:
        return self.pfx("signer-b", self.signer_b, PASSWORD_B, [self.inter.cert, self.root.cert])

    def pfx_expiring(self) -> Path:
        return self.pfx("expiring", self.expiring, PASSWORD_EXPIRING, [self.inter.cert])

    def pfx_expired(self) -> Path:
        return self.pfx("expired", self.expired, PASSWORD_EXPIRED, [self.inter.cert])

    def pfx_revoked(self) -> Path:
        return self.pfx(
            "revoked", self.revoked, PASSWORD_REVOKED, [self.inter.cert, self.root.cert]
        )

    def pfx_a_without_root(self) -> Path:
        """Chain that does not include the Root CA (the caller must supply the trust root)."""
        return self.pfx("signer-a-noroot", self.signer_a, PASSWORD_A, [self.inter.cert])


def _key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _name(*attrs: tuple[ObjectIdentifier, str]) -> x509.Name:
    # One attribute per RDN, in the order given (as real Vietnamese certificates do).
    return x509.Name(
        [x509.RelativeDistinguishedName([x509.NameAttribute(oid, value)]) for oid, value in attrs]
    )


def _cert(
    subject: x509.Name,
    issuer: x509.Name,
    pub: rsa.RSAPublicKey,
    issuer_key: rsa.RSAPrivateKey,
    *,
    not_before: dt.datetime,
    not_after: dt.datetime,
    extensions: list[tuple[x509.ExtensionType, bool]],
) -> x509.Certificate:
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(pub)
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(pub), critical=False)
    )
    for ext, critical in extensions:
        builder = builder.add_extension(ext, critical=critical)
    return builder.sign(issuer_key, hashes.SHA256())


def _ca_usage() -> x509.KeyUsage:
    return x509.KeyUsage(
        digital_signature=True,
        content_commitment=False,
        key_encipherment=False,
        data_encipherment=False,
        key_agreement=False,
        key_cert_sign=True,
        crl_sign=True,
        encipher_only=False,
        decipher_only=False,
    )


def _signer_usage() -> x509.KeyUsage:
    return x509.KeyUsage(
        digital_signature=True,
        content_commitment=True,  # nonRepudiation: pyHanko requires it by default
        key_encipherment=True,
        data_encipherment=False,
        key_agreement=False,
        key_cert_sign=False,
        crl_sign=False,
        encipher_only=False,
        decipher_only=False,
    )


def _crl_point(url: str) -> x509.CRLDistributionPoints:
    point = x509.DistributionPoint([x509.UniformResourceIdentifier(url)], None, None, None)
    return x509.CRLDistributionPoints([point])


def _build_crl(issuer_name: x509.Name, issuer_key: rsa.RSAPrivateKey, revoked: list[int]) -> bytes:
    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(issuer_name)
        .last_update(NOW - dt.timedelta(hours=1))
        .next_update(NOW + dt.timedelta(days=7))
    )
    for serial in revoked:
        builder = builder.add_revoked_certificate(
            x509.RevokedCertificateBuilder()
            .serial_number(serial)
            .revocation_date(NOW - dt.timedelta(minutes=30))
            .build()
        )
    crl = builder.sign(issuer_key, hashes.SHA256())
    return crl.public_bytes(serialization.Encoding.DER)


def build_pki(services: LocalServices, directory: Path) -> Pki:
    """Create the whole test PKI. CRL URLs point at ``services`` (already started)."""
    directory.mkdir(parents=True, exist_ok=True)
    long_ago = NOW - dt.timedelta(days=400)
    year = NOW + dt.timedelta(days=365)
    base = services.base_url

    root_key = _key()
    root_name = _name(
        (NameOID.COUNTRY_NAME, "VN"),
        (NameOID.ORGANIZATION_NAME, "Chef PDF Test Root (gia lap NEAC)"),
        (NameOID.COMMON_NAME, "Chef Test Root CA"),
    )
    root_cert = _cert(
        root_name,
        root_name,
        root_key.public_key(),
        root_key,
        not_before=long_ago,
        not_after=NOW + dt.timedelta(days=3650),
        extensions=[
            (x509.BasicConstraints(ca=True, path_length=1), True),
            (_ca_usage(), True),
        ],
    )

    inter_key = _key()
    inter_name = _name(
        (NameOID.COUNTRY_NAME, "VN"),
        (NameOID.ORGANIZATION_NAME, "Cong ty CA Thu Nghiem"),
        (NameOID.ORGANIZATIONAL_UNIT_NAME, "Trung tam Chung thuc"),
        (NameOID.COMMON_NAME, "Chef Test CA SHA-256"),
    )
    inter_cert = _cert(
        inter_name,
        root_name,
        inter_key.public_key(),
        root_key,
        not_before=long_ago,
        not_after=NOW + dt.timedelta(days=1825),
        extensions=[
            (x509.BasicConstraints(ca=True, path_length=0), True),
            (_ca_usage(), True),
            (x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False),
            (_crl_point(f"{base}/crl/root.crl"), False),
        ],
    )

    def signer(
        subject: x509.Name,
        *,
        not_before: dt.datetime,
        not_after: dt.datetime,
    ) -> Identity:
        key = _key()
        cert = _cert(
            subject,
            inter_name,
            key.public_key(),
            inter_key,
            not_before=not_before,
            not_after=not_after,
            extensions=[
                (x509.BasicConstraints(ca=False, path_length=None), True),
                (_signer_usage(), True),
                (
                    x509.ExtendedKeyUsage(
                        [ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.EMAIL_PROTECTION]
                    ),
                    False,
                ),
                (x509.AuthorityKeyIdentifier.from_issuer_public_key(inter_key.public_key()), False),
                (_crl_point(f"{base}/crl/inter.crl"), False),
            ],
        )
        return Identity(key, cert)

    def person(cn: str, *extra: tuple[ObjectIdentifier, str]) -> x509.Name:
        return _name(
            (NameOID.COUNTRY_NAME, "VN"),
            (NameOID.STATE_OR_PROVINCE_NAME, "Hà Nội"),
            (NameOID.ORGANIZATION_NAME, "Công ty TNHH Thử Nghiệm"),
            (NameOID.TITLE, "Giám đốc"),
            (NameOID.COMMON_NAME, cn),
            *extra,
        )

    signer_a = signer(
        person(
            "Nguyễn Văn A",
            (UID_OID, "MST:0101234567"),
            (UID_OID, "CCCD:001234567890"),
        ),
        not_before=NOW - dt.timedelta(days=1),
        not_after=year,
    )
    signer_b = signer(
        _name(
            (NameOID.COUNTRY_NAME, "VN"),
            (NameOID.ORGANIZATION_NAME, "Công ty Cổ phần Ví Dụ"),
            (NameOID.COMMON_NAME, "Trần Thị B"),
            (NameOID.ORGANIZATIONAL_UNIT_NAME, "MST:0309876543"),
            (UID_OID, "CCCD:079123456789"),
        ),
        not_before=NOW - dt.timedelta(days=1),
        not_after=year,
    )
    expiring = signer(
        person("Hết Hạn Sớm", (UID_OID, "CMND:012345678")),
        not_before=NOW - dt.timedelta(days=300),
        not_after=NOW + dt.timedelta(days=10),
    )
    expired = signer(
        person("Đã Hết Hạn", (UID_OID, "CMND:011111111")),
        not_before=NOW - dt.timedelta(days=400),
        not_after=NOW - dt.timedelta(days=1),
    )
    revoked = signer(
        person("Bị Thu Hồi", (UID_OID, "CCCD:001999999999")),
        not_before=NOW - dt.timedelta(days=1),
        not_after=year,
    )

    tsa_key = _key()
    tsa_cert = _cert(
        _name((NameOID.COUNTRY_NAME, "VN"), (NameOID.COMMON_NAME, "Chef Test TSA")),
        root_name,
        tsa_key.public_key(),
        root_key,
        not_before=long_ago,
        not_after=year,
        extensions=[
            (x509.BasicConstraints(ca=False, path_length=None), True),
            (x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), True),
            (x509.KeyUsage(True, False, False, False, False, False, False, False, False), True),
            (x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), False),
        ],
    )

    services.crls["inter.crl"] = _build_crl(inter_name, inter_key, [revoked.cert.serial_number])
    services.crls["root.crl"] = _build_crl(root_name, root_key, [])
    services.tsa = DummyTimeStamper(
        tsa_cert=asn1_x509.Certificate.load(tsa_cert.public_bytes(serialization.Encoding.DER)),
        tsa_key=PrivateKeyInfo.load(
            tsa_key.private_bytes(
                serialization.Encoding.DER,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        ),
        certs_to_embed=None,
    )

    root_pem = directory / "root.pem"
    root_pem.write_bytes(root_cert.public_bytes(serialization.Encoding.PEM))
    return Pki(
        root=Identity(root_key, root_cert),
        inter=Identity(inter_key, inter_cert),
        signer_a=signer_a,
        signer_b=signer_b,
        expiring=expiring,
        expired=expired,
        revoked=revoked,
        tsa=Identity(tsa_key, tsa_cert),
        root_pem=root_pem,
        directory=directory,
    )


def dead_url() -> str:
    """A loopback URL where nothing listens (connection refused, immediately)."""
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"http://127.0.0.1:{port}/tsa"


@dataclass(frozen=True)
class SignatureStatus:
    field: str
    intact: bool
    valid: bool
    trusted: bool
    signer: str | None
    has_timestamp: bool
    modification_level: str | None


@dataclass(frozen=True)
class DocumentValidation:
    signatures: list[SignatureStatus]
    doc_timestamps: int


def validate_pdf_signatures(path: Path, root_cert: x509.Certificate) -> DocumentValidation:
    """Validate every signature in ``path`` with pyHanko (the test-side integrity check).

    Revocation is checked online against the loopback CRLs (hard-fail), so a fetch problem
    makes the signature invalid instead of passing silently.
    """
    trust = asn1_x509.Certificate.load(root_cert.public_bytes(serialization.Encoding.DER))

    def context() -> ValidationContext:
        return ValidationContext(
            trust_roots=[trust], allow_fetching=True, revocation_mode="hard-fail"
        )

    statuses: list[SignatureStatus] = []
    with path.open("rb") as fh:
        reader = PdfFileReader(fh)
        for emb in reader.embedded_regular_signatures:
            st = validate_pdf_signature(emb, context(), ts_validation_context=context())
            statuses.append(
                SignatureStatus(
                    field=emb.field_name,
                    intact=bool(st.intact),
                    valid=bool(st.valid),
                    trusted=bool(st.trusted),
                    signer=st.signing_cert.subject.human_friendly if st.signing_cert else None,
                    has_timestamp=st.timestamp_validity is not None,
                    modification_level=st.modification_level.name
                    if st.modification_level
                    else None,
                )
            )
        doc_ts = 0
        for emb_ts in reader.embedded_timestamp_signatures:
            ts = validate_pdf_timestamp(emb_ts, validation_context=context())
            assert ts.intact and ts.valid, f"document timestamp invalid: {ts}"
            doc_ts += 1
    return DocumentValidation(signatures=statuses, doc_timestamps=doc_ts)
