"""Enumerate slots/tokens/certs without a PIN and study PIN-related token flags.

Uses a *separate throwaway token* (CHEF-LOCKTEST) for wrong-PIN experiments so the
signing token is never touched. Results go to s1/out/pin_flags.json.
"""

from __future__ import annotations

import json
import subprocess

import pkcs11
from cryptography import x509
from pkcs11 import Attribute, Mechanism, ObjectClass, TokenFlag
from pkcs11.exceptions import PinIncorrect, PinLocked, PKCS11Error, UserAlreadyLoggedIn

from .common import OUT, SO_PIN, TOKEN_LABEL, USER_PIN, softhsm_env, softhsm_lib

PIN_FLAGS = (
    TokenFlag.USER_PIN_COUNT_LOW,
    TokenFlag.USER_PIN_FINAL_TRY,
    TokenFlag.USER_PIN_LOCKED,
    TokenFlag.USER_PIN_TO_BE_CHANGED,
)


def pin_state(token) -> list[str]:
    return [f.name for f in PIN_FLAGS if token.flags & f]


def enumerate_without_pin(lib) -> list[dict]:
    out = []
    for slot in lib.get_slots(token_present=True):
        tok = slot.get_token()
        entry = {
            "slot_id": slot.slot_id,
            "slot_description": slot.slot_description,
            "slot_manufacturer": slot.manufacturer_id,
            "token_label": tok.label,
            "token_serial": tok.serial.decode(errors="replace") if isinstance(tok.serial, bytes) else tok.serial,
            "token_manufacturer": tok.manufacturer_id,
            "token_model": tok.model,
            "flags": [f.name for f in TokenFlag if f and tok.flags & f],
            "rsa_sha256_mech": Mechanism.SHA256_RSA_PKCS in slot.get_mechanisms(),
            "rsa_raw_mech": Mechanism.RSA_PKCS in slot.get_mechanisms(),
            "certs": [],
        }
        if not tok.flags & TokenFlag.TOKEN_INITIALIZED:
            # SoftHSM always exposes one extra empty slot; C_OpenSession fails on it.
            entry["note"] = "token not initialised; skipped"
            out.append(entry)
            continue
        with tok.open() as s:  # public session, no C_Login
            for obj in s.get_objects({Attribute.CLASS: ObjectClass.CERTIFICATE}):
                c = x509.load_der_x509_certificate(obj[Attribute.VALUE])
                entry["certs"].append({
                    "label": obj[Attribute.LABEL],
                    "id": obj[Attribute.ID].hex(),
                    "subject": c.subject.rfc4514_string(),
                    "not_after": c.not_valid_after_utc.isoformat(),
                    "is_ca": _is_ca(c),
                })
            entry["private_keys_visible_without_login"] = len(
                list(s.get_objects({Attribute.CLASS: ObjectClass.PRIVATE_KEY}))
            )
        out.append(entry)
    return out


def _is_ca(c: x509.Certificate) -> bool:
    try:
        return c.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
    except x509.ExtensionNotFound:
        return False


def main() -> None:
    softhsm_env()
    res: dict = {}
    # Throwaway token for lockout experiments (delete leftovers from earlier runs).
    # Done via softhsm2-util *before* loading the module in this process: deleting a
    # token behind a loaded module's back makes C_GetTokenInfo fail (CKR_GENERAL_ERROR).
    slots_txt = subprocess.run(["softhsm2-util", "--show-slots"], capture_output=True,
                               text=True).stdout
    label = serial = None
    for line in slots_txt.splitlines():
        line = line.strip()
        if line.startswith("Serial number:"):
            serial = line.split(":", 1)[1].strip()
        elif line.startswith("Label:"):
            label = line.split(":", 1)[1].strip()
            if label == "CHEF-LOCKTEST" and serial:
                subprocess.run(["softhsm2-util", "--delete-token", "--serial", serial],
                               check=True, capture_output=True)
    subprocess.run(["softhsm2-util", "--init-token", "--free", "--label", "CHEF-LOCKTEST",
                    "--pin", "111111", "--so-pin", SO_PIN], check=True, capture_output=True)
    lib = pkcs11.lib(softhsm_lib())
    res["library"] = {"manufacturer": lib.manufacturer_id, "description": lib.library_description,
                      "cryptoki_version": list(lib.cryptoki_version),
                      "library_version": list(lib.library_version)}
    res["slots"] = enumerate_without_pin(lib)

    # Wrong PIN experiment on the throwaway token.
    attempts = []
    for i in range(1, 13):
        tok = lib.get_token(token_label="CHEF-LOCKTEST")  # re-read C_GetTokenInfo each time
        before = pin_state(tok)
        try:
            tok.open(user_pin="000000").close()
            outcome = "logged in?!"
        except PinIncorrect:
            outcome = "CKR_PIN_INCORRECT"
        except PinLocked:
            outcome = "CKR_PIN_LOCKED"
        except PKCS11Error as e:
            outcome = type(e).__name__
        after = pin_state(lib.get_token(token_label="CHEF-LOCKTEST"))
        attempts.append({"attempt": i, "flags_before": before, "result": outcome, "flags_after": after})
    res["wrong_pin_attempts"] = attempts
    tok = lib.get_token(token_label="CHEF-LOCKTEST")
    try:
        tok.open(user_pin="111111").close()
        res["correct_pin_after_12_wrong"] = "OK (SoftHSM2 has no lockout counter)"
    except PinLocked:
        res["correct_pin_after_12_wrong"] = "CKR_PIN_LOCKED"

    # Pitfall: login state is per application+token, not per session.
    tok = lib.get_token(token_label=TOKEN_LABEL)
    s1 = tok.open(user_pin=USER_PIN)
    try:
        s2 = tok.open(user_pin=USER_PIN)
        res["second_login_same_process"] = "OK (python-pkcs11 tolerated it)"
        s2.close()
    except UserAlreadyLoggedIn:
        res["second_login_same_process"] = "CKR_USER_ALREADY_LOGGED_IN"
    try:
        s3 = tok.open()  # no PIN: shares the login state of s1
        n = len(list(s3.get_objects({Attribute.CLASS: ObjectClass.PRIVATE_KEY})))
        res["private_keys_visible_in_new_session_without_pin_while_logged_in"] = n
        s3.close()
    finally:
        s1.close()

    (OUT / "pin_flags.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
