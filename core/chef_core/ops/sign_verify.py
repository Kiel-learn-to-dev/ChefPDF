"""Signature verification and the signed-revision view (features I34, I35).

``sign.verify`` checks the signatures of the session document (its current revision). It is not
finalizing and not destructive: nothing is committed, so it is allowed at any time.

``sign.verifyFile`` checks any PDF on disk without a session. ``sign.extractRevision`` writes the
bytes a signature covers, so the UI can show "what was signed".

``trustRootPaths`` names extra trust roots: certificate files, or folders of certificate files
(a user trust store folder can be passed that way).
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field

from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.signing.trust import TrustStore, load_trust_paths
from chef_core.signing.verify import VerifyOptions, extract_revision, verify_document

PATH_DOC = "Path of the PDF file."


class VerifyParams(WireModel):
    """Verify the signatures of the document."""

    trust_root_paths: list[str] = Field(
        default_factory=list,
        description="Extra trust roots: certificate files (PEM or DER) or folders of them. "
        "The bundled trust folder is always used.",
    )
    check_revocation: Literal["none", "soft", "hard"] = Field(
        default="soft",
        description="none: no revocation check. soft: a failed check is a warning. "
        "hard: a failed check makes the signature unknown.",
    )
    allow_offline: bool = Field(
        default=True,
        description="False: treat an unreachable revocation server like hard mode.",
    )
    timeout_seconds: int = Field(
        default=15, ge=1, le=120, description="Timeout of each CRL or OCSP request."
    )


class VerifyFileParams(VerifyParams):
    """Verify the signatures of a PDF file (no session needed)."""

    path: str = Field(min_length=1, description=PATH_DOC)


class ExtractRevisionParams(WireModel):
    """Write the document as it was when one signature was applied."""

    path: str = Field(min_length=1, description=PATH_DOC)
    field_name: str = Field(min_length=1, description="Name of the signed signature field.")
    output_path: str = Field(
        min_length=1, description="Path of the PDF to write. It must not be the source file."
    )


def _options(p: VerifyParams) -> VerifyOptions:
    return VerifyOptions(
        trust=TrustStore(user_dir=None),
        extra_trust_roots=load_trust_paths(p.trust_root_paths),
        check_revocation=p.check_revocation,
        allow_offline=p.allow_offline,
        timeout_seconds=p.timeout_seconds,
    )


@operation(
    id="sign.verify",
    title="Verify signatures",
    group="sign",
    params=VerifyParams,
)
def verify_op(ctx: OpContext, p: VerifyParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("sign.verify needs a session")
    ctx.check_cancelled()
    data = verify_document(ctx.input_path, _options(p))
    return OpOutput(changed_pages=[], data=data)


@operation(
    id="sign.verifyFile",
    title="Verify signatures of a file",
    group="sign",
    params=VerifyFileParams,
    standalone=True,
)
def verify_file_op(ctx: OpContext, p: VerifyFileParams) -> OpOutput:
    ctx.check_cancelled()
    data = verify_document(Path(p.path).expanduser().absolute(), _options(p))
    return OpOutput(changed_pages=[], data=data)


@operation(
    id="sign.extractRevision",
    title="Show the signed version",
    group="sign",
    params=ExtractRevisionParams,
    standalone=True,
)
def extract_revision_op(ctx: OpContext, p: ExtractRevisionParams) -> OpOutput:
    ctx.check_cancelled()
    out = extract_revision(
        Path(p.path).expanduser().absolute(),
        p.field_name,
        Path(p.output_path).expanduser().absolute(),
    )
    return OpOutput(changed_pages=[], outputs=[str(out)])
