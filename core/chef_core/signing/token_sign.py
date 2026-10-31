"""PAdES signing with a key on a USB token (feature I1, task T3.01).

The token key enters the existing engine as a pyHanko signer. ``PfxCertificate`` is only the
carrier (signer + certificate + chain), so the same ``sign_pades`` path, the same timestamp
chain and the same validation context serve both PFX and token signing. Nothing in pades.py
changes.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from cryptography import x509

from chef_core.signing.pades import (
    AppearanceStreamProvider,
    DigestName,
    PadesRequest,
    PadesResult,
    SigningLevel,
    VisibleSpot,
    sign_pades,
)
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


def sign_with_token(
    session: TokenSession,
    cert: TokenCertificate,
    chain: Sequence[x509.Certificate],
    *,
    source: Path,
    destination: Path,
    level: SigningLevel,
    digest: DigestName,
    tsa_urls: tuple[str, ...],
    trust_roots: tuple[x509.Certificate, ...],
    field_name: str | None,
    spot: VisibleSpot | None,
    reason: str | None,
    location: str | None,
    contact_info: str | None,
    appearance: AppearanceStreamProvider,
) -> PadesResult:
    """Sign ``source`` into ``destination`` with the token key. Raises ``ChefError``."""
    return sign_pades(
        PadesRequest(
            source=source,
            destination=destination,
            signer=token_identity(session, cert, chain),
            level=level,
            digest=digest,
            tsa_urls=tsa_urls,
            trust_roots=trust_roots,
            field_name=field_name,
            spot=spot,
            reason=reason,
            location=location,
            contact_info=contact_info,
            appearance=appearance,
        )
    )
