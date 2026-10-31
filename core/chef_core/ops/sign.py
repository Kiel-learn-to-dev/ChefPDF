"""Digital signature operations (group I): sign.certInfo and sign.pades.

sign.pades is ``finalizing``: after it runs the session is marked as signed (see session manager).
It only appends to the document, so it stays allowed on signed documents.

Both signing ops take the same options (``SignCommonParams``) and build their request with the
same ``build_request`` (see sign_common.py).
"""

from __future__ import annotations

from pydantic import Field

from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.sign_common import (
    SignCommonParams,
    build_request,
    check_signer,
    visible_spot,
)
from chef_core.signing.certinfo import cert_info
from chef_core.signing.pades import sign_pades
from chef_core.signing.pfx import load_pfx

PASSWORD_DOC = "Password of the certificate file. Never stored, logged or echoed back."


class SignCertInfoParams(WireModel):
    """Read the certificate in a .pfx / .p12 file without signing anything."""

    pfx_path: str = Field(min_length=1, description="Path to the .pfx or .p12 file.")
    password: str | None = Field(default=None, repr=False, description=PASSWORD_DOC)


@operation(
    id="sign.certInfo",
    title="Certificate information",
    group="sign",
    params=SignCertInfoParams,
    standalone=True,
)
def cert_info_op(ctx: OpContext, p: SignCertInfoParams) -> OpOutput:
    loaded = load_pfx(p.pfx_path, p.password)
    info = cert_info(loaded.certificate)
    if info.expired:
        ctx.warn("The certificate has expired.")
    elif info.expiring_soon:
        ctx.warn(f"The certificate expires in {info.days_until_expiry} day(s).")
    return OpOutput(data=info.model_dump(by_alias=True, mode="json"))


class SignPadesParams(SignCommonParams):
    """Sign the document with a certificate file (PAdES). Same options as sign.padesToken."""

    pfx_path: str = Field(min_length=1, description="Path to the .pfx or .p12 file.")
    password: str | None = Field(default=None, repr=False, description=PASSWORD_DOC)


@operation(
    id="sign.pades",
    title="Sign with a certificate (PAdES)",
    group="sign",
    params=SignPadesParams,
    finalizing=True,
)
def sign_pades_op(ctx: OpContext, p: SignPadesParams) -> OpOutput:
    if ctx.input_path is None or ctx.result_path is None:
        raise RuntimeError("sign.pades needs a session")
    ctx.check_cancelled()
    loaded = load_pfx(p.pfx_path, p.password)
    info = check_signer(ctx, loaded.certificate)
    spot = visible_spot(ctx.input_path, p.page, p.rect)
    result = sign_pades(
        build_request(
            p,
            source=ctx.input_path,
            destination=ctx.result_path,
            signer=loaded,
            spot=spot,
            field_name=p.field_name,
        )
    )
    ctx.modified = True
    return OpOutput(
        changed_pages=[result.page] if result.page is not None else [],
        data={
            "fieldName": result.field_name,
            "level": p.level,
            "tsaUrl": result.tsa_url,
            "signer": info.model_dump(by_alias=True, mode="json"),
        },
    )
