"""Shared paths and constants for spike S1."""

from __future__ import annotations

import os
from pathlib import Path

S1_DIR = Path(__file__).resolve().parent
OUT = S1_DIR / "out"
PKI = OUT / "pki"
HSM_DIR = OUT / "softhsm"

# Local revocation/TSA services started by revocation_server.py.
REVOCATION_HOST = "127.0.0.1"
REVOCATION_PORT = 18765
BASE_URL = f"http://{REVOCATION_HOST}:{REVOCATION_PORT}"

TOKEN_LABEL = "CHEF-TEST"
USER_PIN = "123456"
SO_PIN = "12345678"
KEY_ID = bytes.fromhex("a1b2c3d4")
# Real Vietnamese tokens usually label objects with the CN; test UTF-8 labels.
KEY_LABEL = "Nguyễn Văn A"

SOFTHSM_CANDIDATES = [
    "/usr/lib/softhsm/libsofthsm2.so",
    "/usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so",
    "/usr/local/lib/softhsm/libsofthsm2.so",
    "/opt/homebrew/lib/softhsm/libsofthsm2.so",
    "/usr/local/opt/softhsm/lib/softhsm/libsofthsm2.so",
]


def softhsm_lib() -> str:
    override = os.environ.get("SOFTHSM2_LIB")
    if override:
        return override
    for c in SOFTHSM_CANDIDATES:
        if Path(c).is_file():
            return c
    raise FileNotFoundError("libsofthsm2.so not found; install softhsm2 or set SOFTHSM2_LIB")


def softhsm_env() -> None:
    """Point SoftHSM2 at a private config/token directory under out/."""
    HSM_DIR.mkdir(parents=True, exist_ok=True)
    tokens = HSM_DIR / "tokens"
    tokens.mkdir(exist_ok=True)
    conf = HSM_DIR / "softhsm2.conf"
    conf.write_text(
        f"directories.tokendir = {tokens}\nobjectstore.backend = file\nlog.level = ERROR\n"
    )
    os.environ["SOFTHSM2_CONF"] = str(conf)
