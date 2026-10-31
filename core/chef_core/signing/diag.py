"""Token diagnostics (features I6 and I7, task T3.03).

``run_diagnostics`` walks a fixed ladder of checks and returns one step per check, in order.
A step whose prerequisite failed is ``skipped``. Nothing here logs in: the PIN is never asked
for, so the signing self-test is always ``skipped`` (it belongs to the signing step).

Every ``fail`` and ``warn`` carries a fix a non-technical user can follow, in Vietnamese and
English. Step ids are part of the contract with the UI wizard; do not rename them.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from chef_core.errors import ChefError
from chef_core.signing.certinfo import cert_info
from chef_core.signing.drivers import (
    current_environment,
    scan_drivers,
    validate_module_path,
)
from chef_core.signing.pkcs11 import (
    CertListing,
    PinState,
    SlotInfo,
    TokenInfo,
    current_backend,
)

OK = "ok"
WARN = "warn"
FAIL = "fail"
SKIPPED = "skipped"

STEP_DRIVER_FOUND = "driver_found"
STEP_DRIVER_LOADS = "driver_loads"
STEP_TOKEN_PRESENT = "token_present"
STEP_TOKEN_INITIALIZED = "token_initialized"
STEP_CERT_READABLE = "certificate_readable"
STEP_CERT_VALIDITY = "certificate_validity"
STEP_PIN_STATE = "pin_state"
STEP_SELF_TEST = "signing_self_test"


@dataclass(frozen=True)
class DiagStep:
    id: str
    status: str
    title_vi: str
    title_en: str
    detail: str
    fix_vi: str | None = None
    fix_en: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "titleVi": self.title_vi,
            "titleEn": self.title_en,
            "detail": self.detail,
            "fixVi": self.fix_vi,
            "fixEn": self.fix_en,
        }


_TITLES: dict[str, tuple[str, str]] = {
    STEP_DRIVER_FOUND: ("Tìm thấy driver của token", "Token driver found"),
    STEP_DRIVER_LOADS: ("Nạp được driver", "Driver loads"),
    STEP_TOKEN_PRESENT: ("Phát hiện token đang cắm", "Token detected"),
    STEP_TOKEN_INITIALIZED: ("Token đã được khởi tạo", "Token is initialised"),
    STEP_CERT_READABLE: ("Đọc được chứng thư ký", "Signing certificate readable"),
    STEP_CERT_VALIDITY: ("Chứng thư còn hiệu lực", "Certificate still valid"),
    STEP_PIN_STATE: ("Trạng thái mã PIN", "PIN status"),
    STEP_SELF_TEST: ("Thử ký", "Signing test"),
}

_FIX_DRIVER_MISSING = (
    "Cài phần mềm ký số hoặc driver token do CA cấp (Viettel-CA, VNPT-CA, FPT-CA, "
    "Ban Cơ yếu…), rồi thử lại. Nếu đã cài, bấm 'Quét tìm driver' hoặc chọn file driver "
    "bằng tay.",
    "Install the driver or signing software your CA supplied for the token "
    "(Viettel-CA, VNPT-CA, FPT-CA, Ban Co yeu...), then try again. If it is already "
    "installed, press 'Scan for drivers' or choose the driver file yourself.",
)
_FIX_ARCH = (
    "Driver này không khớp với Chef PDF (32-bit hay 64-bit). Chef PDF là bản 64-bit: hãy "
    "chọn driver nằm trong thư mục System32 hoặc bản 64-bit do CA cung cấp.",
    "This driver does not match Chef PDF (32-bit or 64-bit). Chef PDF is the 64-bit build: "
    "choose the driver in System32, or the 64-bit version from your CA.",
)
_FIX_DRIVER_LOAD = (
    "Không nạp được driver. Hãy cài lại driver của CA, khởi động lại máy, rồi đóng các "
    "phần mềm ký số khác đang chạy.",
    "The driver could not be loaded. Reinstall the CA's driver, restart the computer, "
    "then close other signing software that is running.",
)
_FIX_NO_TOKEN = (
    "Cắm chắc token vào cổng USB (thử cổng khác), rút ra rồi cắm lại. Nếu phần mềm ký số "
    "của CA đang mở, hãy đóng nó.",
    "Plug the token firmly into a USB port (try another port), unplug it and plug it back "
    "in. If the CA's signing software is open, close it.",
)
_FIX_SLOT_MISSING = (
    "Không thấy token ở vị trí đã chọn. Cắm lại token rồi thử lại.",
    "No token in the selected slot. Plug the token in again and retry.",
)
_FIX_READ_ERROR = (
    "Không đọc được thông tin token. Đóng phần mềm ký số đang dùng token, rút ra cắm lại.",
    "The token could not be read. Close the signing software using it, then unplug and "
    "plug it back in.",
)
_WARN_MULTI = (
    "Đang cắm nhiều token. Rút bớt token không dùng để tránh chọn nhầm.",
    "More than one token is plugged in. Unplug the ones you do not use to avoid choosing "
    "the wrong one.",
)
_FIX_NOT_INIT = (
    "Token chưa được khởi tạo. Dùng phần mềm của CA để khởi tạo, hoặc liên hệ CA.",
    "The token is not initialised. Use the CA's software to initialise it, or contact the CA.",
)
_FIX_NO_CERT = (
    "Không tìm thấy chứng thư trên token. Kiểm tra token bằng phần mềm của CA; có thể cần "
    "liên hệ CA cấp lại.",
    "No certificate was found on the token. Check it with the CA's software; you may need "
    "to ask the CA to reissue it.",
)
_FIX_NO_SIGNER = (
    "Token không chứa chứng thư người ký. Kiểm tra lại đây có đúng token của bạn không.",
    "The token holds no signer certificate. Check that this is your token.",
)
_WARN_UNREADABLE = (
    "Một số đối tượng trên token không đọc được. Thường không ảnh hưởng nếu chứng thư người "
    "ký đọc được.",
    "Some objects on the token could not be read. This is usually harmless when the signer "
    "certificate reads correctly.",
)
_FIX_EXPIRED = (
    "Chứng thư đã hết hạn. Liên hệ CA để gia hạn hoặc cấp chứng thư mới.",
    "The certificate has expired. Contact the CA to renew or reissue it.",
)
_WARN_EXPIRING = (
    "Chứng thư sắp hết hạn (dưới 30 ngày). Nên liên hệ CA gia hạn sớm.",
    "The certificate expires within 30 days. Contact the CA to renew it soon.",
)
_FIX_LOCKED = (
    "Token đã bị khóa vì nhập sai PIN quá nhiều. Không nhập PIN nữa. Liên hệ CA để mở khóa.",
    "The token is locked after too many wrong PINs. Stop entering the PIN and contact the "
    "CA to unlock it.",
)
_FIX_FINAL_TRY_VI = (
    "Token chỉ còn 1 lần thử, nhập sai PIN có thể khóa token. Nhập đúng PIN ngay, hoặc "
    "liên hệ CA trước nếu chưa chắc. Không thử đoán."
)
_FIX_FINAL_TRY_EN = (
    "Only 1 try left, a wrong PIN may lock it. Enter the correct PIN now, or contact the "
    "CA first if unsure. Do not guess."
)
_FIX_COUNT_LOW_VI = (
    "Token đã ghi nhận một lần nhập sai trước đó, có thể chỉ còn ít lần thử. Nhập sai "
    "có thể khóa token. Chỉ nhập PIN khi chắc chắn; không thử đoán."
)
_FIX_COUNT_LOW_EN = (
    "The token recorded a wrong PIN earlier, so only a few tries may be left. A wrong "
    "PIN may lock it. Enter the PIN only when sure; do not guess."
)
_FIX_TO_BE_CHANGED = (
    "Token yêu cầu đổi PIN. Đổi PIN bằng phần mềm của CA rồi thử lại.",
    "The token requires a PIN change. Change the PIN with the CA's software, then retry.",
)
_SELF_TEST_SKIPPED = (
    "Không thử ký khi chưa nhập PIN. Ký thật ở bước Ký số.",
    "No signing test without the PIN. Sign for real in the signing step.",
)


def _title(step_id: str) -> tuple[str, str]:
    return _TITLES[step_id]


def _ok(step_id: str, detail: str) -> DiagStep:
    vi, en = _title(step_id)
    return DiagStep(step_id, OK, vi, en, detail)


def _fail(step_id: str, detail: str, fix: tuple[str, str]) -> DiagStep:
    vi, en = _title(step_id)
    return DiagStep(step_id, FAIL, vi, en, detail, fix[0], fix[1])


def _warn(
    step_id: str, detail: str, fix: tuple[str, str], title: tuple[str, str] | None = None
) -> DiagStep:
    vi, en = title or _title(step_id)
    return DiagStep(step_id, WARN, vi, en, detail, fix[0], fix[1])


def _skip(step_id: str, because: str) -> DiagStep:
    vi, en = _title(step_id)
    return DiagStep(step_id, SKIPPED, vi, en, f"skipped: {because}")


def _skip_rest(steps: list[DiagStep], from_index: int, because: str) -> list[DiagStep]:
    """Mark the remaining ladder steps as skipped after a failed prerequisite."""
    ids = [s.id for s in steps]
    for step_id in _LADDER[from_index:]:
        if step_id not in ids:
            steps.append(_skip(step_id, because))
    return steps


_LADDER = [
    STEP_DRIVER_FOUND,
    STEP_DRIVER_LOADS,
    STEP_TOKEN_PRESENT,
    STEP_TOKEN_INITIALIZED,
    STEP_CERT_READABLE,
    STEP_CERT_VALIDITY,
    STEP_PIN_STATE,
    STEP_SELF_TEST,
]


def _pick_token(slots: list[SlotInfo], slot_id: int | None) -> tuple[TokenInfo | None, str | None]:
    """The token to diagnose, and the read error of the relevant slot when there is no token."""
    if slot_id is not None:
        for slot in slots:
            if slot.slot_id == slot_id:
                return (slot.token, slot.read_error)
        return (None, None)
    present = [s for s in slots if s.token is not None]
    if present:
        return (present[0].token, None)
    return (None, next((s.read_error for s in slots if s.read_error), None))


def _check_certificates(listing: CertListing, now: dt.datetime) -> tuple[DiagStep, DiagStep | None]:
    signers = [c for c in listing.certificates if not c.is_ca]
    if not listing.certificates and listing.unreadable == 0:
        return (_fail(STEP_CERT_READABLE, "no certificate objects", _FIX_NO_CERT), None)
    if not signers:
        return (_fail(STEP_CERT_READABLE, "only CA certificates", _FIX_NO_SIGNER), None)
    count = len(signers)
    if listing.unreadable:
        cert_step = _warn(
            STEP_CERT_READABLE,
            f"{count} signer certificate(s), {listing.unreadable} object(s) unreadable",
            _WARN_UNREADABLE,
        )
    else:
        cert_step = _ok(STEP_CERT_READABLE, f"{count} signer certificate(s)")
    infos = [cert_info(c.certificate, now) for c in signers]
    valid = [i for i in infos if not i.expired and not i.expiring_soon]
    soon = [i for i in infos if not i.expired and i.expiring_soon]
    earliest = min(i.not_after for i in infos)
    if valid:
        validity = _ok(STEP_CERT_VALIDITY, f"valid until {max(i.not_after for i in valid)}")
    elif soon:
        validity = _warn(
            STEP_CERT_VALIDITY,
            f"expires {soon[0].not_after} ({soon[0].days_until_expiry} day(s) left)",
            _WARN_EXPIRING,
        )
    else:
        validity = _fail(STEP_CERT_VALIDITY, f"expired at {earliest}", _FIX_EXPIRED)
    return (cert_step, validity)


def _pin_step(token: TokenInfo) -> DiagStep:
    state = token.pin_state
    flags = ", ".join(token.flags) or "none"
    if state is PinState.LOCKED:
        return _fail(STEP_PIN_STATE, f"flags: {flags}", _FIX_LOCKED)
    if state is PinState.FINAL_TRY:
        return _warn(
            STEP_PIN_STATE,
            f"flags: {flags}",
            (_FIX_FINAL_TRY_VI, _FIX_FINAL_TRY_EN),
            title=("Token chỉ còn 1 lần thử", "PIN status: only 1 try left"),
        )
    if state is PinState.COUNT_LOW:
        return _warn(
            STEP_PIN_STATE,
            f"flags: {flags}",
            (_FIX_COUNT_LOW_VI, _FIX_COUNT_LOW_EN),
            title=("Đã có lần nhập PIN sai", "PIN status: a wrong PIN was recorded"),
        )
    if state is PinState.TO_BE_CHANGED:
        return _warn(STEP_PIN_STATE, f"flags: {flags}", _FIX_TO_BE_CHANGED)
    return _ok(STEP_PIN_STATE, f"flags: {flags}")


def run_diagnostics(
    *,
    module_path: str | None,
    slot_id: int | None,
    now: dt.datetime | None = None,
) -> list[dict[str, Any]]:
    """Run the ladder. ``module_path`` None means: use the first driver the scan finds."""
    env = current_environment()
    current = now or dt.datetime.now(dt.UTC)
    steps: list[DiagStep] = []

    # 1. driver file
    module = module_path
    if module is None:
        found = [h for h in scan_drivers(env) if h.exists]
        module = found[0].path if found else None
    if module is None:
        steps.append(_fail(STEP_DRIVER_FOUND, "no candidate driver exists", _FIX_DRIVER_MISSING))
        return [
            s.to_wire()
            for s in _skip_rest(steps, _LADDER.index(STEP_DRIVER_LOADS), "no driver file")
        ]
    try:
        validate_module_path(module, env.os_name, env.fs)
    except ChefError as exc:
        steps.append(_fail(STEP_DRIVER_FOUND, exc.kind.value, _FIX_DRIVER_MISSING))
        return [
            s.to_wire()
            for s in _skip_rest(steps, _LADDER.index(STEP_DRIVER_LOADS), "no driver file")
        ]
    steps.append(_ok(STEP_DRIVER_FOUND, module))

    # 2. driver loads
    try:
        backend = current_backend()
        slots = backend.load_slots(module)
    except ChefError as exc:
        if exc.kind.value == "TOKEN_SUPPORT_UNAVAILABLE":
            steps.append(_fail(STEP_DRIVER_LOADS, exc.kind.value, _FIX_DRIVER_LOAD))
            return [
                s.to_wire()
                for s in _skip_rest(
                    steps, _LADDER.index(STEP_TOKEN_PRESENT), "token support missing"
                )
            ]
        reason = str(exc.detail.get("reason")) if isinstance(exc.detail, dict) else exc.kind.value
        fix = _FIX_ARCH if reason == "architecture" else _FIX_DRIVER_LOAD
        steps.append(_fail(STEP_DRIVER_LOADS, reason, fix))
        return [
            s.to_wire()
            for s in _skip_rest(steps, _LADDER.index(STEP_TOKEN_PRESENT), "driver does not load")
        ]
    steps.append(_ok(STEP_DRIVER_LOADS, f"{len(slots)} slot(s)"))

    # 3. token present
    token, read_error = _pick_token(slots, slot_id)
    if token is None:
        if read_error is not None:
            steps.append(
                _fail(STEP_TOKEN_PRESENT, f"slot read error: {read_error}", _FIX_READ_ERROR)
            )
        elif slot_id is not None:
            steps.append(
                _fail(STEP_TOKEN_PRESENT, f"no token in slot {slot_id}", _FIX_SLOT_MISSING)
            )
        else:
            steps.append(_fail(STEP_TOKEN_PRESENT, "no token found", _FIX_NO_TOKEN))
        return [
            s.to_wire()
            for s in _skip_rest(steps, _LADDER.index(STEP_TOKEN_INITIALIZED), "no token")
        ]
    present = [s for s in slots if s.token is not None]
    if slot_id is None and len(present) > 1:
        steps.append(_warn(STEP_TOKEN_PRESENT, f"{len(present)} tokens", _WARN_MULTI))
    else:
        steps.append(_ok(STEP_TOKEN_PRESENT, f"{token.label} (slot {token.slot_id})"))

    # 4. token initialised
    if not token.initialized:
        steps.append(_fail(STEP_TOKEN_INITIALIZED, "not initialised", _FIX_NOT_INIT))
        return [
            s.to_wire()
            for s in _skip_rest(steps, _LADDER.index(STEP_CERT_READABLE), "token not initialised")
        ]
    steps.append(_ok(STEP_TOKEN_INITIALIZED, token.label))

    # 5 and 6. certificates and validity (the PIN is not needed)
    listing = backend.certificates(module, token.slot_id)
    cert_step, validity_step = _check_certificates(listing, current)
    steps.append(cert_step)
    if validity_step is None:
        return [
            s.to_wire()
            for s in _skip_rest(steps, _LADDER.index(STEP_CERT_VALIDITY), "no signer certificate")
        ]
    steps.append(validity_step)

    # 7. PIN state from the flags (read again by the login call before any PIN is used)
    steps.append(_pin_step(token))

    # 8. signing self-test: never without the PIN
    vi, en = _title(STEP_SELF_TEST)
    steps.append(
        DiagStep(
            STEP_SELF_TEST,
            SKIPPED,
            vi,
            en,
            "not run: needs the PIN",
            _SELF_TEST_SKIPPED[0],
            _SELF_TEST_SKIPPED[1],
        )
    )
    return [s.to_wire() for s in steps]
