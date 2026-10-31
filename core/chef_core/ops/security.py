"""Password and permissions (features J1, J2; T5.01).

``security.encrypt`` (session) sets a user and/or owner password and the permissions. Nothing
is written to the document at once: the profile is recorded in the session (``pendingEncryption``
in ``session.state``) and applied by the next ``session.save``. Passwords live in memory only;
the journal and meta.json never hold them.

``security.decrypt`` (session) removes the protection on the next save. ``password`` is checked
against the password the session was opened with; the check is only needed when given.

``security.encryptFile`` (standalone, batch-friendly) encrypts a file on disk.

All three are destructive: on a signed document they are blocked (BLOCKED_BY_SIGNATURE), since
re-encrypting rewrites the file.

Encryption is AES-256 (R=6). A protection change is lost when a crashed session is restored
(see ``session/recovery.py``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import atomic_save, open_pdf
from chef_core.session.info import has_signatures
from chef_core.session.manager import EncryptionState

PASSWORD_DOC = "Password. Empty or null: no password is needed to open the file."


class PermissionFlags(WireModel):
    """What a reader may do when the file is opened with the user password."""

    print_low_res: bool = Field(default=True, description="Print at low resolution.")
    print_high_res: bool = Field(
        default=True, description="Print at high resolution. Needs printLowRes."
    )
    copy_content: bool = Field(default=True, description="Copy text and images.")
    modify: bool = Field(default=True, description="Make other changes to the document.")
    annotate: bool = Field(default=True, description="Add or change comments.")
    fill_forms: bool = Field(default=True, description="Fill in form fields.")
    assemble: bool = Field(default=True, description="Insert, delete, rotate pages.")
    accessibility: bool = Field(default=True, description="Accessibility tools may read it.")

    @model_validator(mode="after")
    def _print_levels(self) -> PermissionFlags:
        if self.print_high_res and not self.print_low_res:
            raise ValueError("printHighRes needs printLowRes")
        return self

    def to_pikepdf(self) -> pikepdf.Permissions:
        return pikepdf.Permissions(
            accessibility=self.accessibility,
            extract=self.copy_content,
            modify_annotation=self.annotate,
            modify_assembly=self.assemble,
            modify_form=self.fill_forms,
            modify_other=self.modify,
            print_lowres=self.print_low_res,
            print_highres=self.print_high_res,
        )


class ProtectionParams(WireModel):
    """Password(s) and permissions. At least one password is required."""

    user_password: str | None = Field(default=None, description=PASSWORD_DOC)
    owner_password: str | None = Field(
        default=None,
        description="Password that changes the permissions. Null: the user password is used.",
    )
    permissions: PermissionFlags = Field(default_factory=PermissionFlags)

    @model_validator(mode="after")
    def _need_a_password(self) -> ProtectionParams:
        if not self.user_password and not self.owner_password:
            raise ValueError("a user or an owner password is required")
        return self

    def state(self) -> EncryptionState:
        user = self.user_password or ""
        owner = self.owner_password or user
        return EncryptionState(
            allow=self.permissions.to_pikepdf(), user_password=user, owner_password=owner
        )

    def encryption(self) -> pikepdf.Encryption:
        state = self.state()
        return pikepdf.Encryption(
            user=state.user_password,
            owner=state.owner_password or state.user_password,
            R=6,
            allow=state.allow,
        )

    def profile(self) -> dict[str, Any]:
        """Non-secret description, kept in meta.json."""
        return {
            "action": "encrypt",
            "algorithm": "AES-256",
            "userPasswordSet": bool(self.user_password),
            "ownerPasswordSet": bool(self.owner_password),
            "permissions": self.permissions.model_dump(by_alias=True),
        }


class DecryptParams(WireModel):
    """Remove the protection of the document on the next save."""

    password: str | None = Field(
        default=None,
        description="Password of the file, checked against the one it was opened with.",
    )


class EncryptFileParams(ProtectionParams):
    """Encrypt a PDF file on disk (no session)."""

    input_path: str = Field(min_length=1, description="PDF file to encrypt.")
    input_password: str | None = Field(default=None, description="Password of the input file.")
    output_path: str = Field(
        min_length=1, description="Path of the encrypted PDF. May be the input path."
    )


@operation(
    id="security.encrypt",
    title="Set password and permissions",
    group="security",
    params=ProtectionParams,
    destructive=True,
)
def encrypt(ctx: OpContext, p: ProtectionParams) -> OpOutput:
    state = p.state()
    profile = p.profile()

    def record(session: Any) -> None:
        session.set_protection(state, profile, "security.encrypt", p)

    return OpOutput(changed_pages=[], session_effect=record)


@operation(
    id="security.decrypt",
    title="Remove password",
    group="security",
    params=DecryptParams,
    destructive=True,
)
def decrypt(ctx: OpContext, p: DecryptParams) -> OpOutput:
    current = ctx.protection
    if current is None:
        ctx.warn("The document is not protected; nothing to remove.")
        return OpOutput(changed_pages=[])
    if p.password and p.password not in (current.user_password, current.owner_password):
        raise ChefError(ErrorKind.PASSWORD_INVALID, "Invalid password")

    def record(session: Any) -> None:
        session.set_protection(None, {"action": "remove"}, "security.decrypt", p)

    return OpOutput(changed_pages=[], session_effect=record)


@operation(
    id="security.encryptFile",
    title="Encrypt a file",
    group="security",
    params=EncryptFileParams,
    standalone=True,
    batchable=True,
)
def encrypt_file(ctx: OpContext, p: EncryptFileParams) -> OpOutput:
    src = Path(p.input_path).expanduser().absolute()
    dest = Path(p.output_path).expanduser().absolute()
    if dest.is_dir():
        raise invalid_params("outputPath is a directory", {"field": "outputPath"})
    ctx.check_cancelled()
    pdf = open_pdf(src, p.input_password)
    try:
        if has_signatures(pdf):
            raise ChefError(
                ErrorKind.BLOCKED_BY_SIGNATURE,
                "The document is signed; encrypting it would break the signatures",
                {"path": str(src)},
            )
        # The output may be the input: release the input before the rename (Windows).
        atomic_save(pdf, dest, before_replace=pdf.close, encryption=p.encryption())
    finally:
        pdf.close()
    return OpOutput(changed_pages=[], outputs=[str(dest)])
