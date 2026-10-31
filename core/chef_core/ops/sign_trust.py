"""Trust store operations (I35): sign.trustList, sign.trustAdd and sign.trustRemove.

The bundled certificates ship with the app and cannot be removed. The user store is the folder
``<data-dir>/trust``: certificates added here are trusted by every verification and by B-LT
signing. None of these ops needs a document or a PIN.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.signing.trust import default_trust_roots, default_trust_store, user_trust_dir


class TrustListParams(WireModel):
    """No parameters: the bundled and the user certificates."""


@operation(
    id="sign.trustList",
    title="List trusted certificates",
    group="sign",
    params=TrustListParams,
    standalone=True,
)
def trust_list_op(ctx: OpContext, p: TrustListParams) -> OpOutput:
    ctx.check_cancelled()
    folder = user_trust_dir()
    return OpOutput(
        data={
            "certificates": default_trust_store().list(),
            "folders": [str(f) for f in default_trust_roots()],
            "userFolder": str(folder) if folder is not None else None,
        }
    )


class TrustAddParams(WireModel):
    """Trust the certificates of a file (a root or an intermediate CA)."""

    path: str = Field(min_length=1, description="Certificate file: PEM (one or more) or DER.")
    group: Literal["vn-public-ca", "vn-gov-ca", "user"] = Field(
        default="user",
        description="vn-public-ca: a public CA of Vietnam. vn-gov-ca: the government CA. "
        "user: anything else. Shown in the trust list.",
    )


@operation(
    id="sign.trustAdd",
    title="Trust a certificate",
    group="sign",
    params=TrustAddParams,
    standalone=True,
)
def trust_add_op(ctx: OpContext, p: TrustAddParams) -> OpOutput:
    ctx.check_cancelled()
    added = default_trust_store().add(p.path, p.group)
    return OpOutput(data={"added": added})


class TrustRemoveParams(WireModel):
    """Stop trusting a certificate that was added by the user."""

    fingerprint_sha256: str = Field(
        min_length=1,
        max_length=200,
        description="SHA-256 fingerprint as listed by sign.trustList (colons optional).",
    )


@operation(
    id="sign.trustRemove",
    title="Stop trusting a certificate",
    group="sign",
    params=TrustRemoveParams,
    standalone=True,
)
def trust_remove_op(ctx: OpContext, p: TrustRemoveParams) -> OpOutput:
    ctx.check_cancelled()
    if not default_trust_store().remove(p.fingerprint_sha256):
        raise invalid_params(
            "No user certificate has this fingerprint",
            {"field": "fingerprintSha256"},
        )
    return OpOutput(data={"removed": True})
