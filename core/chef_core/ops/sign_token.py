"""USB token operations (group I): sign.driverScan, sign.listTokens, sign.diagnoseToken and
sign.padesToken.

The three standalone ops never ask for a PIN. ``sign.padesToken`` is a session op and logs in
exactly once, after the PIN policy in ``open_token_session``; the session is always closed in
``finally``. The PIN is a parameter with ``repr=False`` and is removed from the journal
(``SECRET_PARAM_KEYS`` in session/manager.py).
"""

from __future__ import annotations

from typing import Annotated, Any, NamedTuple, Self

from cryptography import x509
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.sign_common import (
    SignCommonParams,
    build_request,
    certify_permission,
    check_signer,
    visible_spot,
)
from chef_core.signing.certinfo import cert_info
from chef_core.signing.diag import run_diagnostics
from chef_core.signing.drivers import (
    current_environment,
    scan_drivers,
    validate_module_path,
)
from chef_core.signing.pades import preflight_pades, sign_pades
from chef_core.signing.pkcs11 import (
    Pkcs11Backend,
    TokenCertificate,
    TokenInfo,
    current_backend,
    is_ca,
    open_token_session,
    select_token,
)
from chef_core.signing.token_sign import token_identity

PageIndex = Annotated[int, Field(ge=0)]
PIN_DOC = "Token PIN. Used for one login and then dropped. Never stored, logged or echoed back."
MODULE_DOC = "Path of the PKCS#11 driver file (.dll, .dylib or .so)."


# -- sign.driverScan -------------------------------------------------------------------------


class DriverScanParams(WireModel):
    """List the known driver files and whether each exists on this computer."""

    probe: bool = Field(
        default=False,
        description="Also load each driver that exists and list the token labels it sees. "
        "No PIN is used.",
    )


def _probe(backend: Pkcs11Backend, path: str) -> dict[str, Any]:
    try:
        slots = backend.load_slots(path)
    except ChefError as exc:
        reason = exc.detail.get("reason") if isinstance(exc.detail, dict) else None
        return {"status": "error", "errorKind": exc.kind.value, "reason": reason, "tokenLabels": []}
    labels = [s.token.label for s in slots if s.token is not None]
    return {"status": "ok", "errorKind": None, "reason": None, "tokenLabels": labels}


@operation(
    id="sign.driverScan",
    title="Scan for token drivers",
    group="sign",
    params=DriverScanParams,
    standalone=True,
)
def driver_scan(ctx: OpContext, p: DriverScanParams) -> OpOutput:
    env = current_environment()
    backend = current_backend() if p.probe else None
    probed: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    for hit in scan_drivers(env):
        row: dict[str, Any] = {
            "ca": hit.ca_name,
            "caId": hit.ca_id,
            "model": hit.model_name,
            "modelId": hit.model_id,
            "path": hit.path,
            "exists": hit.exists,
            "confidence": hit.confidence.value,
            "bitness": hit.bitness,
        }
        if backend is not None and hit.exists:
            if hit.path not in probed:
                probed[hit.path] = _probe(backend, hit.path)
            row["probe"] = probed[hit.path]
        rows.append(row)
    return OpOutput(data={"os": env.os_name, "drivers": rows})


# -- sign.listTokens -------------------------------------------------------------------------


class ListTokensParams(WireModel):
    """Tokens in one driver, with their certificates. No PIN is needed."""

    module_path: str = Field(min_length=1, description=MODULE_DOC)


@operation(
    id="sign.listTokens",
    title="List tokens and certificates",
    group="sign",
    params=ListTokensParams,
    standalone=True,
)
def list_tokens(ctx: OpContext, p: ListTokensParams) -> OpOutput:
    env = current_environment()
    module = validate_module_path(p.module_path, env.os_name, env.fs)
    backend = current_backend()
    tokens: list[dict[str, Any]] = []
    for slot in backend.load_slots(module):
        if slot.token is None:
            continue
        info = slot.token
        certificates: list[dict[str, Any]] = []
        unreadable = 0
        if info.initialized:
            listing = backend.certificates(module, slot.slot_id)
            unreadable = listing.unreadable
            for cert in listing.certificates:
                certificates.append(
                    {
                        "ckaId": cert.cka_id.hex(),
                        "label": cert.label,
                        "isCa": is_ca(cert.certificate),
                        "cert": cert_info(cert.certificate).model_dump(by_alias=True, mode="json"),
                    }
                )
        tokens.append(
            {
                "slotId": slot.slot_id,
                "slotDescription": slot.description,
                "label": info.label,
                "manufacturer": info.manufacturer,
                "model": info.model,
                "serial": info.serial,
                "initialized": info.initialized,
                "pinState": info.pin_state.value,
                "flags": list(info.flags),
                "protectedAuthPath": info.protected_auth_path,
                "unreadableObjects": unreadable,
                "certificates": certificates,
            }
        )
    return OpOutput(data={"modulePath": module, "tokens": tokens})


# -- sign.diagnoseToken ----------------------------------------------------------------------


class DiagnoseTokenParams(WireModel):
    """Run the token checks step by step (driver, token, certificate, PIN state)."""

    module_path: str | None = Field(
        default=None,
        description="Driver to check. Default: the first driver the scan finds.",
    )
    slot_id: int | None = Field(default=None, ge=0, description="Slot of the token to check.")


@operation(
    id="sign.diagnoseToken",
    title="Diagnose the USB token",
    group="sign",
    params=DiagnoseTokenParams,
    standalone=True,
)
def diagnose_token(ctx: OpContext, p: DiagnoseTokenParams) -> OpOutput:
    steps = run_diagnostics(module_path=p.module_path, slot_id=p.slot_id)
    statuses = {str(step["status"]) for step in steps}
    overall = "fail" if "fail" in statuses else "warn" if "warn" in statuses else "ok"
    return OpOutput(data={"steps": steps, "overall": overall})


# -- sign.padesToken -------------------------------------------------------------------------


def token_selector_error(slot_id: int | None, serial: str | None) -> str | None:
    """The message when a token is selected by neither or both of slotId and tokenSerial."""
    if (slot_id is None) == (serial is None):
        return "give exactly one of slotId or tokenSerial"
    return None


class SignPadesTokenParams(SignCommonParams):
    """Sign the document with a key on a USB token (PAdES). Same options as sign.pades."""

    module_path: str = Field(min_length=1, description=MODULE_DOC)
    slot_id: int | None = Field(default=None, ge=0, description="Slot of the token.")
    token_serial: str | None = Field(
        default=None, min_length=1, description="Serial of the token, instead of slotId."
    )
    cert_id: str = Field(
        pattern=r"^(?:[0-9a-fA-F]{2})+$",
        description="CKA_ID of the signing certificate, in hex (from sign.listTokens).",
    )
    pin: str = Field(repr=False, description=PIN_DOC)
    confirm_final_try: bool = Field(
        default=False,
        description="Must be true to use the PIN when the token reports only one try left.",
    )

    @model_validator(mode="after")
    def _one_token_selector(self) -> Self:
        message = token_selector_error(self.slot_id, self.token_serial)
        if message is not None:
            raise ValueError(message)
        return self


class TokenSigner(NamedTuple):
    """A token key chosen by the caller: the token, its signer certificate and the CA chain."""

    token: TokenInfo
    cert: TokenCertificate
    chain: list[x509.Certificate]


def locate_signer(
    backend: Pkcs11Backend,
    module: str,
    *,
    slot_id: int | None,
    serial: str | None,
    cert_id: str,
) -> TokenSigner:
    """Find the token and the signer certificate (no PIN needed). Refuses CA and expired ones."""
    token = select_token(backend, module, slot_id=slot_id, serial=serial)
    listing = backend.certificates(module, token.slot_id)
    wanted = bytes.fromhex(cert_id)
    cert = next((c for c in listing.certificates if c.cka_id == wanted), None)
    if cert is None:
        raise ChefError(
            ErrorKind.TOKEN_NOT_FOUND,
            "The certificate is not on this token",
            {"reason": "certificate"},
        )
    if cert.is_ca:
        raise invalid_params(
            "This is a CA certificate: choose the signer certificate", {"field": "certId"}
        )
    chain = [c.certificate for c in listing.certificates if c.is_ca]
    return TokenSigner(token=token, cert=cert, chain=chain)


@operation(
    id="sign.padesToken",
    title="Sign with a USB token (PAdES)",
    group="sign",
    params=SignPadesTokenParams,
    finalizing=True,
)
def sign_pades_token(ctx: OpContext, p: SignPadesTokenParams) -> OpOutput:
    if ctx.input_path is None or ctx.result_path is None:
        raise RuntimeError("sign.padesToken needs a session")
    ctx.check_cancelled()
    env = current_environment()
    module = validate_module_path(p.module_path, env.os_name, env.fs)
    backend = current_backend()
    chosen = locate_signer(
        backend, module, slot_id=p.slot_id, serial=p.token_serial, cert_id=p.cert_id
    )
    info = check_signer(ctx, chosen.cert.certificate)
    spot = visible_spot(ctx.input_path, p.page, p.rect)
    # Refuse what the document cannot take before the PIN is used.
    preflight_pades(
        ctx.input_path,
        field_name=p.field_name,
        visible=spot is not None,
        certify=certify_permission(p.certify),
        op_id="sign.padesToken",
    )

    session = open_token_session(
        backend, module, chosen.token.slot_id, p.pin, confirm_final_try=p.confirm_final_try
    )
    try:
        result = sign_pades(
            build_request(
                p,
                source=ctx.input_path,
                destination=ctx.result_path,
                signer=token_identity(session, chosen.cert, chosen.chain),
                spot=spot,
                field_name=p.field_name,
            )
        )
    finally:
        session.close()
    ctx.modified = True
    return OpOutput(
        changed_pages=[result.page] if result.page is not None else [],
        data={
            "fieldName": result.field_name,
            "level": p.level,
            "tsaUrl": result.tsa_url,
            "slotId": chosen.token.slot_id,
            "signer": info.model_dump(by_alias=True, mode="json"),
        },
    )
