"""T3.01 with the real python-pkcs11 library.

Runs only when the ``token`` extra is installed (``uv run --extra token pytest``). The SoftHSM2
test additionally needs ``CHEF_SOFTHSM_MODULE`` set to libsofthsm2 (see docs/spikes/S1-pkcs11.md);
it is skipped otherwise. Real hardware tokens are NOT tested here.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing.pkcs11 import RealBackend

HAS_PKCS11 = importlib.util.find_spec("pkcs11") is not None
needs_pkcs11 = pytest.mark.skipif(
    not HAS_PKCS11,
    reason="python-pkcs11 is not installed; run with: uv run --extra token pytest",
)
SOFTHSM = os.environ.get("CHEF_SOFTHSM_MODULE")


@needs_pkcs11
def test_missing_module_is_a_driver_error(tmp_path: Path) -> None:
    backend = RealBackend()
    with pytest.raises(ChefError) as exc:
        backend.load_slots(str(tmp_path / "does-not-exist.so"))
    assert exc.value.kind is ErrorKind.TOKEN_DRIVER_ERROR
    assert exc.value.detail["reason"] in {"not_found", "load_failed"}


@needs_pkcs11
def test_file_that_is_not_a_pkcs11_library_is_a_driver_error(tmp_path: Path) -> None:
    fake = tmp_path / "not-a-library.so"
    fake.write_bytes(b"this is not an ELF or PE file")
    backend = RealBackend()
    with pytest.raises(ChefError) as exc:
        backend.load_slots(str(fake))
    assert exc.value.kind is ErrorKind.TOKEN_DRIVER_ERROR
    assert exc.value.detail["reason"] in {"load_failed", "architecture"}


@needs_pkcs11
@pytest.mark.skipif(
    not SOFTHSM,
    reason="set CHEF_SOFTHSM_MODULE to a SoftHSM2 library (see docs/spikes/S1-pkcs11.md) to run",
)
def test_softhsm_lists_slots_without_a_pin() -> None:
    assert SOFTHSM is not None
    backend = RealBackend()
    slots = backend.load_slots(SOFTHSM)
    assert slots  # SoftHSM always exposes at least one slot
    for slot in slots:
        if slot.token is not None:
            assert slot.token.label is not None
            assert isinstance(slot.token.flags, tuple)
