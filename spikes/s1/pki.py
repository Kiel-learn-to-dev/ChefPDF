"""Generate a test PKI that imitates a Vietnamese CA chain.

Root CA -> intermediate CA -> end-entity signer (Vietnamese UTF-8 subject,
UID attributes carrying MST/CCCD like Vietnamese public CAs do).
Also: an OCSP responder cert, a TSA cert, a revoked signer, and CRLs.

All keys are unencrypted PEM files: TEST ONLY.
"""

from __future__ import annotations

import datetime as dt
import json

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID, ObjectIdentifier

from .common import BASE_URL, PKI

UID_OID = ObjectIdentifier("0.9.2342.19200300.100.1.1")  # userId (UID)
NOW = dt.datetime.now(dt.UTC).replace(microsecond=0)


def _key(bits: int = 2048) -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=bits)


def _name(*attrs: tuple[ObjectIdentifier, str]) -> x509.Name:
    # One attribute per RDN, in the order given (like real VN certs).
    return x509.Name([x509.RelativeDistinguishedName([x509.NameAttribute(o, v)]) for o, v in attrs])


def _save(name: str, key: rsa.RSAPrivateKey | None, cert: x509.Certificate) -> None:
    PKI.mkdir(parents=True, exist_ok=True)
    (PKI / f"{name}.crt.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (PKI / f"{name}.crt.der").write_bytes(cert.public_bytes(serialization.Encoding.DER))
    if key is not None:
        (PKI / f"{name}.key.pem").write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        (PKI / f"{name}.key.der").write_bytes(
            key.private_bytes(
                serialization.Encoding.DER,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )


def _builder(subject, issuer, pub, days, serial=None):
    return (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(pub)
        .serial_number(serial or x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=1))
        .not_valid_after(NOW + dt.timedelta(days=days))
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(pub), critical=False)
    )


def _ca_ku() -> x509.KeyUsage:
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


def _signer_ku() -> x509.KeyUsage:
    return x509.KeyUsage(
        digital_signature=True,
        content_commitment=True,  # nonRepudiation; pyHanko requires it by default
        key_encipherment=True,
        data_encipherment=False,
        key_agreement=False,
        key_cert_sign=False,
        crl_sign=False,
        encipher_only=False,
        decipher_only=False,
    )


def _aki(issuer_key) -> x509.AuthorityKeyIdentifier:
    return x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key())


def _cdp(url: str) -> x509.CRLDistributionPoints:
    return x509.CRLDistributionPoints(
        [x509.DistributionPoint([x509.UniformResourceIdentifier(url)], None, None, None)]
    )


def _aia(ocsp: str | None, ca_issuers: str) -> x509.AuthorityInformationAccess:
    descs = []
    if ocsp:
        descs.append(
            x509.AccessDescription(x509.AuthorityInformationAccessOID.OCSP,
                                   x509.UniformResourceIdentifier(ocsp))
        )
    descs.append(
        x509.AccessDescription(x509.AuthorityInformationAccessOID.CA_ISSUERS,
                               x509.UniformResourceIdentifier(ca_issuers))
    )
    return x509.AuthorityInformationAccess(descs)


def signer_subject(cn: str, cccd: str) -> x509.Name:
    return _name(
        (NameOID.COUNTRY_NAME, "VN"),
        (NameOID.STATE_OR_PROVINCE_NAME, "Hà Nội"),
        (NameOID.LOCALITY_NAME, "Hà Nội"),
        (NameOID.ORGANIZATION_NAME, "Công ty TNHH Thử Nghiệm"),
        (NameOID.TITLE, "Giám đốc"),
        (NameOID.COMMON_NAME, cn),
        (UID_OID, "MST:0101234567"),
        (UID_OID, f"CCCD:{cccd}"),
    )


def main() -> None:
    sha = hashes.SHA256()

    # Root CA (imitates "Vietnam National Root CA")
    root_key = _key(3072)
    root_name = _name(
        (NameOID.COUNTRY_NAME, "VN"),
        (NameOID.ORGANIZATION_NAME, "Chef PDF Test Root (giả lập NEAC)"),
        (NameOID.COMMON_NAME, "Chef Test Root CA"),
    )
    root = (
        _builder(root_name, root_name, root_key.public_key(), 3650)
        .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
        .add_extension(_ca_ku(), critical=True)
        .sign(root_key, sha)
    )
    _save("root", root_key, root)

    # Intermediate CA (imitates "Viettel-CA SHA-256" etc.)
    inter_key = _key()
    inter_name = _name(
        (NameOID.COUNTRY_NAME, "VN"),
        (NameOID.ORGANIZATION_NAME, "Công ty CA Thử Nghiệm"),
        (NameOID.ORGANIZATIONAL_UNIT_NAME, "Trung tâm Chứng thực"),
        (NameOID.COMMON_NAME, "Chef Test CA SHA-256"),
    )
    inter = (
        _builder(inter_name, root_name, inter_key.public_key(), 1825)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(_ca_ku(), critical=True)
        .add_extension(_aki(root_key), critical=False)
        .add_extension(_cdp(f"{BASE_URL}/crl/root.crl"), critical=False)
        .add_extension(_aia(None, f"{BASE_URL}/certs/root.crt"), critical=False)
        .sign(root_key, sha)
    )
    _save("inter", inter_key, inter)

    def signer(cn: str, cccd: str, name: str):
        k = _key()
        c = (
            _builder(signer_subject(cn, cccd), inter_name, k.public_key(), 365)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(_signer_ku(), critical=True)
            .add_extension(
                x509.ExtendedKeyUsage(
                    [ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.EMAIL_PROTECTION]
                ),
                critical=False,
            )
            .add_extension(_aki(inter_key), critical=False)
            .add_extension(_cdp(f"{BASE_URL}/crl/inter.crl"), critical=False)
            .add_extension(_aia(f"{BASE_URL}/ocsp", f"{BASE_URL}/certs/inter.crt"), critical=False)
            .add_extension(
                x509.SubjectAlternativeName([x509.RFC822Name("nguyenvana@example.vn")]),
                critical=False,
            )
            .sign(inter_key, sha)
        )
        _save(name, k, c)
        return k, c

    signer("Nguyễn Văn A", "001234567890", "signer")
    signer("Trần Thị B", "079123456789", "signer2")
    _, revoked = signer("Lê Văn Bị Thu Hồi", "001999999999", "revoked")

    # Delegated OCSP responder under the intermediate.
    ocsp_key = _key()
    ocsp_cert = (
        _builder(_name((NameOID.COUNTRY_NAME, "VN"), (NameOID.COMMON_NAME, "Chef Test OCSP")),
                 inter_name, ocsp_key.public_key(), 365)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.OCSP_SIGNING]), critical=True)
        .add_extension(x509.OCSPNoCheck(), critical=False)
        .add_extension(_aki(inter_key), critical=False)
        .sign(inter_key, sha)
    )
    _save("ocsp", ocsp_key, ocsp_cert)

    # TSA directly under the root (CRL from root).
    tsa_key = _key()
    tsa_cert = (
        _builder(_name((NameOID.COUNTRY_NAME, "VN"), (NameOID.COMMON_NAME, "Chef Test TSA")),
                 root_name, tsa_key.public_key(), 1825)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True)
        .add_extension(_aki(root_key), critical=False)
        .add_extension(_cdp(f"{BASE_URL}/crl/root.crl"), critical=False)
        .sign(root_key, sha)
    )
    _save("tsa", tsa_key, tsa_cert)

    # CRLs (valid 7 days).
    def crl(issuer_name, issuer_key, revoked_serials):
        b = (
            x509.CertificateRevocationListBuilder()
            .issuer_name(issuer_name)
            .last_update(NOW - dt.timedelta(hours=1))
            .next_update(NOW + dt.timedelta(days=7))
            .add_extension(x509.CRLNumber(1), critical=False)
            .add_extension(_aki(issuer_key), critical=False)
        )
        for s in revoked_serials:
            b = b.add_revoked_certificate(
                x509.RevokedCertificateBuilder()
                .serial_number(s)
                .revocation_date(NOW - dt.timedelta(minutes=30))
                .build()
            )
        return b.sign(issuer_key, sha)

    (PKI / "root.crl").write_bytes(crl(root_name, root_key, []).public_bytes(serialization.Encoding.DER))
    (PKI / "inter.crl").write_bytes(
        crl(inter_name, inter_key, [revoked.serial_number]).public_bytes(serialization.Encoding.DER)
    )
    (PKI / "revoked.json").write_text(json.dumps({"serials": [revoked.serial_number]}))
    print(f"PKI written to {PKI}")
    for n in ("root", "inter", "signer", "signer2", "revoked", "ocsp", "tsa"):
        c = x509.load_pem_x509_certificate((PKI / f"{n}.crt.pem").read_bytes())
        print(f"  {n:8s} {c.subject.rfc4514_string()}")


if __name__ == "__main__":
    main()
