"""PAdES signing with a key on a USB token (feature I1, task T3.01).

The token key enters the existing engine as a pyHanko signer. ``PfxCertificate`` is only the
carrier (signer + certificate + chain), so the same ``sign_pades`` path, the same timestamp
chain and the same validation context serve both PFX and token signing. Nothing in pades.py
changes. The request itself is built by ``chef_core.ops.sign_common.build_request``.
"""

from __future__ import annotations

from collections.abc import Sequence

from cryptography import x509

from chef_core.signing.pfx import PfxCertificate
from chef_core.signing.pkcs11 import TokenCertificate, TokenSession


def token_identity(
    session: TokenSession,
    cert: TokenCertificate,
    chain: Sequence[x509.Certificate],
) -> PfxCertificate:
    """A signing identity whose key stays on the token (pyHanko ``PKCS11Signer``)."""
    return PfxCertificate(
        signer=session.signer(cert.cka_id),
        certificate=cert.certificate,
        chain=tuple(chain),
    )
