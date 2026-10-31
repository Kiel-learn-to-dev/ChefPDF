"""Trust store for signature verification (feature I35).

Two sources of certificates:

* the **bundled** folder ``chef_core/resources/certs`` (shipped with the app, read only), and
* the **user** folder, written by ``TrustStore.add`` and emptied by ``TrustStore.remove``.

A verification can also name extra roots with ``trustRootPaths``: a file (PEM with one or more
certificates, or DER) or a folder (every certificate file directly inside it). A user store folder
can be passed that way too.

File names carry the group: ``<group>.<anything>.<ext>`` where ``<group>`` is ``vn-public-ca``
(root and intermediate certificates of the public CAs), ``vn-gov-ca`` (the government CA of Ban Cơ
yếu Chính phủ) or ``user``. A file without a known prefix is listed in the group ``other``.

Certificates with subject equal to issuer are trust anchors; the others are intermediates. Two
copies of the same certificate (same SHA-256 fingerprint) are listed once.
"""

from __future__ import annotations

import builtins
import contextlib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

from chef_core.errors import ChefError, ErrorKind, invalid_params

BUNDLED_CERTS_DIR = Path(__file__).resolve().parent.parent / "resources" / "certs"
CERT_SUFFIXES = frozenset({".pem", ".crt", ".cer", ".der"})
GROUPS: tuple[str, ...] = ("vn-public-ca", "vn-gov-ca", "user")
UNGROUPED = "other"


@dataclass(frozen=True)
class TrustEntry:
    cert: x509.Certificate
    source: str  # "bundled" | "user"
    group: str  # one of GROUPS, or "other"
    path: Path


def fingerprint_of(cert: x509.Certificate) -> str:
    """SHA-256 fingerprint as ``AB:CD:…`` (the format the UI shows)."""
    digest = cert.fingerprint(hashes.SHA256()).hex().upper()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def _normal_fingerprint(value: str) -> str:
    return value.replace(":", "").replace(" ", "").upper()


def _group_of(name: str) -> str:
    lowered = name.lower()
    for group in GROUPS:
        if lowered.startswith(group + "."):
            return group
    return UNGROUPED


def load_certificates(path: Path) -> list[x509.Certificate]:
    """Every certificate in one PEM (possibly several) or DER file."""
    if not path.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(path)})
    data = path.read_bytes()
    try:
        if b"-----BEGIN" in data:
            certs = list(x509.load_pem_x509_certificates(data))
        else:
            certs = [x509.load_der_x509_certificate(data)]
    except ValueError as exc:
        raise ChefError(
            ErrorKind.SIGN_BAD_CERT, "Not a certificate file", {"path": str(path)}
        ) from exc
    if not certs:
        raise ChefError(ErrorKind.SIGN_BAD_CERT, "No certificate in file", {"path": str(path)})
    return certs


def certificate_files(folder: Path) -> list[Path]:
    """Certificate files directly inside ``folder`` (sorted, not recursive)."""
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in CERT_SUFFIXES)


def load_trust_paths(paths: Iterable[str | Path]) -> list[x509.Certificate]:
    """Certificates named by ``trustRootPaths``: files, or folders of certificate files."""
    certs: list[x509.Certificate] = []
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            for file in certificate_files(path):
                certs.extend(load_certificates(file))
        elif path.is_file():
            certs.extend(load_certificates(path))
        else:
            raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(path)})
    return certs


class TrustStore:
    """Bundled and user certificates, with add, list and remove for the user part only."""

    def __init__(self, user_dir: Path | None = None, bundled_dir: Path | None = None) -> None:
        self.user_dir = user_dir
        self.bundled_dir = BUNDLED_CERTS_DIR if bundled_dir is None else bundled_dir

    # -- reading ------------------------------------------------------------------------

    def _raw_entries(self) -> builtins.list[TrustEntry]:
        found: list[TrustEntry] = []
        for path in certificate_files(self.bundled_dir):
            for cert in load_certificates(path):
                found.append(TrustEntry(cert, "bundled", _group_of(path.name), path))
        if self.user_dir is not None:
            for path in certificate_files(self.user_dir):
                for cert in load_certificates(path):
                    found.append(TrustEntry(cert, "user", _group_of(path.name), path))
        return found

    def entries(self) -> builtins.list[TrustEntry]:
        """All certificates, one per fingerprint; bundled copies win over user copies."""
        seen: set[str] = set()
        unique: list[TrustEntry] = []
        for entry in self._raw_entries():
            key = fingerprint_of(entry.cert)
            if key not in seen:
                seen.add(key)
                unique.append(entry)
        return unique

    def certificates(self) -> builtins.list[x509.Certificate]:
        return [entry.cert for entry in self.entries()]

    def anchors(self) -> builtins.list[x509.Certificate]:
        """Self-issued certificates: the trust roots."""
        return [c for c in self.certificates() if c.subject == c.issuer]

    def intermediates(self) -> builtins.list[x509.Certificate]:
        return [c for c in self.certificates() if c.subject != c.issuer]

    def list(self) -> builtins.list[dict[str, Any]]:
        """Rows for the UI: subject, issuer, notAfter, fingerprintSha256, source, group."""
        rows: builtins.list[dict[str, Any]] = []
        for entry in self.entries():
            cert = entry.cert
            rows.append(
                {
                    "subject": cert.subject.rfc4514_string(),
                    "issuer": cert.issuer.rfc4514_string(),
                    "notAfter": cert.not_valid_after_utc.isoformat(),
                    "fingerprintSha256": fingerprint_of(cert),
                    "source": entry.source,
                    "group": entry.group,
                }
            )
        return rows

    # -- writing ------------------------------------------------------------------------

    def add(self, path: str | Path, group: str = "user") -> builtins.list[dict[str, Any]]:
        """Copy the certificates of ``path`` into the user folder. Returns the rows added or known.

        Nothing is written for a certificate that is already listed (bundled or user).
        """
        if group not in GROUPS:
            raise invalid_params(f"group must be one of {', '.join(GROUPS)}", {"field": "group"})
        if self.user_dir is None:
            raise invalid_params("This trust store has no user folder", {"field": "userDir"})
        known = {fingerprint_of(c) for c in self.certificates()}
        certs = load_certificates(Path(path).expanduser())
        self.user_dir.mkdir(parents=True, exist_ok=True)
        for cert in certs:
            fingerprint = fingerprint_of(cert)
            if fingerprint in known:
                continue
            known.add(fingerprint)
            target = self.user_dir / f"{group}.{_normal_fingerprint(fingerprint).lower()}.pem"
            target.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        wanted = {fingerprint_of(c) for c in certs}
        return [row for row in self.list() if row["fingerprintSha256"] in wanted]

    def remove(self, fingerprint: str) -> bool:
        """Delete a user certificate. True if one was deleted, False if none matched.

        Bundled certificates cannot be removed (INVALID_PARAMS).
        """
        wanted = _normal_fingerprint(fingerprint)
        if any(_normal_fingerprint(fingerprint_of(e.cert)) == wanted for e in self._bundled()):
            raise invalid_params("Bundled certificates cannot be removed", {"field": "fingerprint"})
        if self.user_dir is None:
            return False
        removed = False
        for path in certificate_files(self.user_dir):
            for cert in load_certificates(path):
                if _normal_fingerprint(fingerprint_of(cert)) == wanted:
                    with contextlib.suppress(FileNotFoundError):
                        path.unlink()
                    removed = True
        return removed

    def _bundled(self) -> builtins.list[TrustEntry]:
        return [e for e in self._raw_entries() if e.source == "bundled"]


# -- the app's trust folders (set once by the core at start-up) -----------------------------

_USER_TRUST_DIR: Path | None = None


def set_user_trust_dir(path: Path | None) -> None:
    """The user trust folder of this process (``<data-dir>/trust``), or None for none."""
    global _USER_TRUST_DIR
    _USER_TRUST_DIR = path


def user_trust_dir() -> Path | None:
    return _USER_TRUST_DIR


def default_trust_store() -> TrustStore:
    """Bundled roots plus the user's own certificates: what every verification trusts."""
    return TrustStore(user_dir=_USER_TRUST_DIR)


def default_trust_roots() -> list[Path]:
    """The folders behind ``default_trust_store`` (bundled first, then the user folder)."""
    folders = [BUNDLED_CERTS_DIR]
    if _USER_TRUST_DIR is not None:
        folders.append(_USER_TRUST_DIR)
    return folders
