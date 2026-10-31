"""JSON-RPC 2.0 server over newline-delimited JSON on a pair of binary streams.

- One JSON object per line in both directions (UTF-8, ``\\n`` terminated).
- Writes are serialised with a lock, so notifications from worker threads never interleave.
- A handler returns either a plain JSON-serialisable result, a ``Future`` (the response is
  written when it completes) or a ``Deferred`` (result + callback run right after the
  response has been written, e.g. to start a job only after its id reached the client).
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, BinaryIO

from chef_core.errors import (
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    ChefError,
    ErrorKind,
    to_chef_error,
)

log = logging.getLogger(__name__)

JsonDict = dict[str, Any]
Handler = Callable[[JsonDict], Any]
RequestId = str | int | None


@dataclass
class Deferred:
    """Handler result whose ``after`` callback runs once the response has been written."""

    result: Any
    after: Callable[[], None]


class RpcServer:
    def __init__(self, inp: BinaryIO, out: BinaryIO) -> None:
        self._inp = inp
        self._out = out
        self._write_lock = threading.Lock()
        self._handlers: dict[str, Handler] = {}
        self._stopping = threading.Event()

    # -- registration -------------------------------------------------------------------

    def register(self, method: str, handler: Handler) -> None:
        if method in self._handlers:
            raise ValueError(f"method already registered: {method}")
        self._handlers[method] = handler

    @property
    def methods(self) -> list[str]:
        return sorted(self._handlers)

    # -- output -------------------------------------------------------------------------

    def _write(self, message: JsonDict) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        data = line.encode("utf-8") + b"\n"
        with self._write_lock:
            try:
                self._out.write(data)
                self._out.flush()
            except (BrokenPipeError, ValueError, OSError):
                # The client went away; reading stdin will hit EOF and stop the server.
                log.warning("could not write to stdout (client gone)")

    def notify(self, method: str, params: JsonDict) -> None:
        """Send a notification (no id) to the client. Safe to call from any thread."""
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond(self, req_id: RequestId, result: Any) -> None:
        try:
            self._write({"jsonrpc": "2.0", "id": req_id, "result": result})
        except (TypeError, ValueError) as exc:
            log.exception("result of request %r is not JSON-serialisable", req_id)
            self._respond_error(req_id, to_chef_error(exc))

    def _respond_error(self, req_id: RequestId, error: ChefError) -> None:
        self._write({"jsonrpc": "2.0", "id": req_id, "error": error.to_rpc()})

    # -- input --------------------------------------------------------------------------

    def stop(self) -> None:
        """Ask the read loop to stop after the current message."""
        self._stopping.set()

    @property
    def stopping(self) -> bool:
        return self._stopping.is_set()

    def serve_forever(self) -> None:
        """Read and dispatch messages until stdin EOF or ``stop()``."""
        while not self._stopping.is_set():
            raw = self._inp.readline()
            if not raw:
                log.info("stdin closed")
                break
            line = raw.strip()
            if not line:
                continue
            self.handle_line(line)

    def handle_line(self, line: bytes) -> None:
        try:
            message = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._respond_error(
                None,
                ChefError(ErrorKind.INVALID_PARAMS, f"Parse error: {exc}", code=PARSE_ERROR),
            )
            return
        self.handle_message(message)

    def handle_message(self, message: Any) -> None:
        if not isinstance(message, dict):
            self._respond_error(None, _invalid_request("Request must be a JSON object"))
            return

        has_id = "id" in message
        req_id = message.get("id")
        if has_id and not (req_id is None or isinstance(req_id, str | int)):
            self._respond_error(None, _invalid_request("Invalid request id"))
            return
        if isinstance(req_id, bool):
            self._respond_error(None, _invalid_request("Invalid request id"))
            return

        method = message.get("method")
        if message.get("jsonrpc") != "2.0" or not isinstance(method, str):
            if has_id:
                self._respond_error(req_id, _invalid_request("Not a JSON-RPC 2.0 request"))
            return

        params = message.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            error = ChefError(ErrorKind.INVALID_PARAMS, "params must be an object")
            if has_id:
                self._respond_error(req_id, error)
            return

        handler = self._handlers.get(method)
        if handler is None:
            if has_id:
                self._respond_error(
                    req_id,
                    ChefError(
                        ErrorKind.OP_NOT_FOUND,
                        f"Method not found: {method}",
                        {"method": method},
                        code=METHOD_NOT_FOUND,
                    ),
                )
            return

        self._invoke(handler, method, params, req_id if has_id else _NO_ID)

    def _invoke(self, handler: Handler, method: str, params: JsonDict, req_id: Any) -> None:
        notification = req_id is _NO_ID
        try:
            outcome = handler(params)
        except Exception as exc:
            error = to_chef_error(exc)
            if error.kind is ErrorKind.INTERNAL:
                log.exception("error in %s", method)
            else:
                log.info("%s failed: %s (%s)", method, error.kind, error.message)
            if not notification:
                self._respond_error(req_id, error)
            return

        if isinstance(outcome, Future):
            outcome.add_done_callback(
                lambda fut: self._complete_future(fut, method, req_id, notification)
            )
            return

        after: Callable[[], None] | None = None
        if isinstance(outcome, Deferred):
            after = outcome.after
            outcome = outcome.result
        if not notification:
            self._respond(req_id, outcome)
        if after is not None:
            after()

    def _complete_future(
        self, fut: Future[Any], method: str, req_id: Any, notification: bool
    ) -> None:
        if fut.cancelled():
            if not notification:
                self._respond_error(
                    req_id, ChefError(ErrorKind.CANCELLED, "Request cancelled (core stopping)")
                )
            return
        exc = fut.exception()
        if exc is not None:
            error = to_chef_error(exc)
            if error.kind is ErrorKind.INTERNAL:
                log.error("error in %s", method, exc_info=exc)
            else:
                log.info("%s failed: %s (%s)", method, error.kind, error.message)
            if not notification:
                self._respond_error(req_id, error)
            return
        if not notification:
            self._respond(req_id, fut.result())


class _NoId:
    def __repr__(self) -> str:
        return "<no id>"


_NO_ID = _NoId()


def _invalid_request(message: str) -> ChefError:
    return ChefError(ErrorKind.INVALID_PARAMS, message, code=INVALID_REQUEST)
