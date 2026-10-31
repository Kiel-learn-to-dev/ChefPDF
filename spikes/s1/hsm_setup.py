"""Initialise a SoftHSM2 token and import the test signer key + cert chain.

Imitates how Vietnamese CA tokens are provisioned: one RSA key pair, the
signer cert with the same CKA_ID, plus intermediate/root certs on the token.
Import is done with python-pkcs11 (portable; no pkcs11-tool needed).
"""

from __future__ import annotations

import shutil
import subprocess

import pkcs11
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from pkcs11 import Attribute, CertificateType, ObjectClass
from pkcs11.util.rsa import decode_rsa_private_key

from .common import (
    HSM_DIR,
    KEY_ID,
    KEY_LABEL,
    PKI,
    SO_PIN,
    TOKEN_LABEL,
    USER_PIN,
    softhsm_env,
    softhsm_lib,
)


def _cert_attrs(name: str, label: str, cid: bytes) -> dict:
    der = (PKI / f"{name}.crt.der").read_bytes()
    c = x509.load_der_x509_certificate(der)
    return {
        Attribute.CLASS: ObjectClass.CERTIFICATE,
        Attribute.CERTIFICATE_TYPE: CertificateType.X_509,
        Attribute.TOKEN: True,
        Attribute.PRIVATE: False,  # certs readable without PIN, like real tokens
        Attribute.LABEL: label,
        Attribute.ID: cid,
        Attribute.SUBJECT: c.subject.public_bytes(),
        Attribute.ISSUER: c.issuer.public_bytes(),
        Attribute.SERIAL_NUMBER: c.serial_number.to_bytes(20, "big").lstrip(b"\0"),
        Attribute.VALUE: der,
    }


def main() -> None:
    tokens = HSM_DIR / "tokens"
    if tokens.exists():
        shutil.rmtree(tokens)
    softhsm_env()
    subprocess.run(
        ["softhsm2-util", "--init-token", "--free", "--label", TOKEN_LABEL,
         "--pin", USER_PIN, "--so-pin", SO_PIN],
        check=True, capture_output=True,
    )
    lib = pkcs11.lib(softhsm_lib())
    token = lib.get_token(token_label=TOKEN_LABEL)
    with token.open(rw=True, user_pin=USER_PIN) as s:
        key = serialization.load_pem_private_key((PKI / "signer.key.pem").read_bytes(), None)
        der_rsa = key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.TraditionalOpenSSL,  # PKCS#1 RSAPrivateKey
            serialization.NoEncryption(),
        )
        attrs = decode_rsa_private_key(der_rsa)
        attrs.update({
            Attribute.TOKEN: True,
            Attribute.PRIVATE: True,
            Attribute.SENSITIVE: True,
            Attribute.EXTRACTABLE: False,
            Attribute.SIGN: True,
            Attribute.LABEL: KEY_LABEL,
            Attribute.ID: KEY_ID,
        })
        s.create_object(attrs)
        s.create_object(_cert_attrs("signer", KEY_LABEL, KEY_ID))
        s.create_object(_cert_attrs("inter", "Chef Test CA SHA-256", b"\x02"))
        s.create_object(_cert_attrs("root", "Chef Test Root CA", b"\x03"))
    print(f"SoftHSM token '{TOKEN_LABEL}' ready (SOFTHSM2_CONF under {HSM_DIR}); "
          f"user PIN {USER_PIN}, key/cert id {KEY_ID.hex()} label {KEY_LABEL!r}")


if __name__ == "__main__":
    main()
