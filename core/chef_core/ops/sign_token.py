"""USB token operations (group I): sign.driverScan, sign.listTokens, sign.diagnoseToken and
sign.padesToken.

The three standalone ops never ask for a PIN. ``sign.padesToken`` is a session op and logs in
exactly once, after the PIN policy in ``open_token_session``; the session is always closed in
``finally``. The PIN is a parameter with ``repr=False`` and is removed from the journal
(``SECRET_PARAM_KEYS`` in session/manager.py).
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import Field, field_validator, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import opened_pdf
from chef_core.signing.certinfo import cert_info
from chef_core.signing.diag import run_diagnostics
from chef_core.signing.drivers import (
    current_environment,
    scan_drivers,
    validate_module_path,
)
from chef_core.signing.pades import (
    AppearanceStreamProvider,
    DigestName,
    PlaceholderAppearance,
    SigningLevel,
    VisibleSpot,
    load_certificate_files,
)
from chef_core.signing.pkcs11 import (
    Pkcs11Backend,
    current_backend,
    is_ca,
    open_token_session,
    select_token,
)
from chef_core.signing.token_sign import sign_with_token
from chef_core.signing.tsa import ALLOWED_SCHEMES

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


class SignPadesTokenParams(WireModel):
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
    level: Literal["B-B", "B-T", "B-LT", "B-LTA"] = Field(
        default="B-B",
        description="B-B: signature only. B-T: + timestamp. B-LT: + revocation data. "
        "B-LTA: + document timestamp for long-term validity.",
    )
    digest: Literal["sha256", "sha384", "sha512"] = "sha256"
    tsa_urls: list[str] = Field(
        default_factory=list,
        description="Timestamp servers, tried in order. Required for B-T and above.",
    )
    trust_root_paths: list[str] = Field(
        default_factory=list,
        description="Extra trust roots (PEM or DER) for B-LT and B-LTA.",
    )
    reason: str | None = None
    location: str | None = None
    contact_info: str | None = None
    field_name: str | None = Field(
        default=None,
        description="Signature field name. Default: the first free Signature<N>.",
    )
    page: PageIndex | None = Field(
        default=None, description="0-based page for a visible signature. Needs rect."
    )
    rect: Annotated[list[float], Field(min_length=4, max_length=4)] | None = Field(
        default=None, description="[x1, y1, x2, y2] in PDF points. Needs page."
    )

    @field_validator("tsa_urls")
    @classmethod
    def _tsa_schemes(cls, urls: list[str]) -> list[str]:
        for url in urls:
            if not url.startswith(ALLOWED_SCHEMES):
                raise ValueError("timestamp server URLs must start with http:// or https://")
        return urls

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if (self.slot_id is None) == (self.token_serial is None):
            raise ValueError("give exactly one of slotId or tokenSerial")
        if (self.page is None) != (self.rect is None):
            raise ValueError("page and rect must be given together for a visible signature")
        if self.rect is not None:
            x1, y1, x2, y2 = self.rect
            if x2 <= x1 or y2 <= y1:
                raise ValueError("rect must be [x1, y1, x2, y2] with x2 > x1 and y2 > y1")
        if self.level != "B-B" and not self.tsa_urls:
            raise ValueError(f"level {self.level} needs at least one tsaUrls entry")
        return self


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
    token = select_token(backend, module, slot_id=p.slot_id, serial=p.token_serial)

    listing = backend.certificates(module, token.slot_id)
    wanted = bytes.fromhex(p.cert_id)
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
    info = cert_info(cert.certificate)
    if info.expired:
        raise ChefError(
            ErrorKind.SIGN_CERT_EXPIRED,
            "The certificate has expired",
            {"notAfter": info.not_after},
        )
    if info.expiring_soon:
        ctx.warn(f"The certificate expires in {info.days_until_expiry} day(s).")

    spot: VisibleSpot | None = None
    if p.page is not None and p.rect is not None:
        with opened_pdf(ctx.input_path) as doc:
            count = len(doc.pages)
        if p.page >= count:
            raise invalid_params("Page is out of range", {"field": "page"})
        spot = VisibleSpot(page=p.page, rect=(p.rect[0], p.rect[1], p.rect[2], p.rect[3]))

    chain = [c.certificate for c in listing.certificates if c.is_ca]
    trust_roots = load_certificate_files(p.trust_root_paths)
    appearance: AppearanceStreamProvider = PlaceholderAppearance()
    level: SigningLevel = p.level
    digest: DigestName = p.digest

    session = open_token_session(
        backend, module, token.slot_id, p.pin, confirm_final_try=p.confirm_final_try
    )
    try:
        result = sign_with_token(
            session,
            cert,
            chain,
            source=Path(ctx.input_path),
            destination=Path(ctx.result_path),
            level=level,
            digest=digest,
            tsa_urls=tuple(p.tsa_urls),
            trust_roots=trust_roots,
            field_name=p.field_name,
            spot=spot,
            reason=p.reason,
            location=p.location,
            contact_info=p.contact_info,
            appearance=appearance,
        )
    finally:
        session.close()
    ctx.modified = True
    changed = [p.page] if p.page is not None and spot is not None else []
    return OpOutput(
        changed_pages=changed,
        data={
            "fieldName": result.field_name,
            "level": level,
            "tsaUrl": result.tsa_url,
            "slotId": token.slot_id,
            "signer": info.model_dump(by_alias=True, mode="json"),
        },
    )
