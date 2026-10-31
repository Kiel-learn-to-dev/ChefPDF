"""Error types shared by the RPC server, job runner, sessions and operations.

Every error that crosses the RPC boundary carries a stable ``kind`` (see ``ErrorKinds`` in
``packages/contracts/src/rpc.ts``) and is mapped to a JSON-RPC error code as described in
``docs/CONTRACTS.md`` section 3.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

import pydantic

# JSON-RPC 2.0 error codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS_CODE = -32602
APPLICATION_ERROR = -32000


class ErrorKind(StrEnum):
    PASSWORD_REQUIRED = "PASSWORD_REQUIRED"
    PASSWORD_INVALID = "PASSWORD_INVALID"
    FILE_NOT_FOUND = "FILE_NOT_FOUND"
    INVALID_PDF = "INVALID_PDF"
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    OP_NOT_FOUND = "OP_NOT_FOUND"
    INVALID_PARAMS = "INVALID_PARAMS"
    BLOCKED_BY_SIGNATURE = "BLOCKED_BY_SIGNATURE"
    SIGN_BAD_PASSWORD = "SIGN_BAD_PASSWORD"
    SIGN_BAD_CERT = "SIGN_BAD_CERT"
    SIGN_CERT_EXPIRED = "SIGN_CERT_EXPIRED"
    SIGN_TSA_FAILED = "SIGN_TSA_FAILED"
    SIGN_FAILED = "SIGN_FAILED"
    TOKEN_NOT_FOUND = "TOKEN_NOT_FOUND"
    TOKEN_PIN_INVALID = "TOKEN_PIN_INVALID"
    TOKEN_PIN_LOCKED = "TOKEN_PIN_LOCKED"
    TOKEN_PIN_CONFIRM_REQUIRED = "TOKEN_PIN_CONFIRM_REQUIRED"
    TOKEN_DRIVER_ERROR = "TOKEN_DRIVER_ERROR"
    TOKEN_SUPPORT_UNAVAILABLE = "TOKEN_SUPPORT_UNAVAILABLE"
    CANCELLED = "CANCELLED"
    INTERNAL = "INTERNAL"


class ChefError(Exception):
    """An error with a stable machine-readable kind.

    ``message`` is a short English developer message (the UI translates by ``kind``).
    ``detail`` is optional JSON-serialisable extra data. Never put passwords or document
    content into either.
    """

    def __init__(
        self,
        kind: ErrorKind,
        message: str,
        detail: Any = None,
        *,
        code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.detail = detail
        self._code = code

    @property
    def code(self) -> int:
        if self._code is not None:
            return self._code
        if self.kind is ErrorKind.INVALID_PARAMS:
            return INVALID_PARAMS_CODE
        return APPLICATION_ERROR

    def to_rpc(self) -> dict[str, Any]:
        data: dict[str, Any] = {"kind": self.kind.value}
        if self.detail is not None:
            data["detail"] = self.detail
        return {"code": self.code, "message": self.message, "data": data}


class CancelledError(ChefError):
    """Raised by ``OpContext.check_cancelled`` when the job was cancelled."""

    def __init__(self) -> None:
        super().__init__(ErrorKind.CANCELLED, "Job cancelled")


def invalid_params(message: str, detail: Any = None) -> ChefError:
    return ChefError(ErrorKind.INVALID_PARAMS, message, detail)


def from_validation_error(exc: pydantic.ValidationError) -> ChefError:
    """Convert a pydantic validation error into an ``INVALID_PARAMS`` error."""
    errors = [
        {
            "loc": [str(part) for part in err.get("loc", ())],
            "msg": err.get("msg", ""),
            "type": err.get("type", ""),
        }
        for err in exc.errors(include_url=False, include_input=False)
    ]
    first = errors[0] if errors else {"loc": [], "msg": "invalid params"}
    where = ".".join(first["loc"]) if first["loc"] else "params"
    return invalid_params(f"Invalid params: {where}: {first['msg']}", {"errors": errors})


def to_chef_error(exc: BaseException) -> ChefError:
    """Map any exception to a ``ChefError`` (unknown exceptions become ``INTERNAL``)."""
    if isinstance(exc, ChefError):
        return exc
    if isinstance(exc, pydantic.ValidationError):
        return from_validation_error(exc)
    if isinstance(exc, FileNotFoundError):
        return ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": exc.filename})
    return ChefError(ErrorKind.INTERNAL, f"Internal error: {type(exc).__name__}: {exc}")
