"""RFC 3161 timestamp authorities with an ordered fallback chain (part of feature I28).

Each URL gets its own timeout. When every URL fails, the chain raises ``TsaChainFailed``; the
caller turns that into ``SIGN_TSA_FAILED``. A signature is never silently downgraded from B-T to
B-B because a server was down.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pyhanko.sign.timestamps import HTTPTimeStamper
from pyhanko.sign.timestamps.api import TimeStamper

TSA_TIMEOUT_SECONDS = 10.0
ALLOWED_SCHEMES = ("http://", "https://")


class TsaChainFailed(Exception):
    """Every timestamp server in the chain failed. ``failures`` lists URL and error type."""

    def __init__(self, failures: list[dict[str, str]]) -> None:
        super().__init__("all timestamp servers failed")
        self.failures = failures


class FallbackTimeStamper(TimeStamper):
    """pyHanko timestamper that tries ``urls`` in order until one answers."""

    def __init__(self, urls: Sequence[str], *, timeout: float = TSA_TIMEOUT_SECONDS) -> None:
        # pyHanko does not annotate TimeStamper.__init__; the call is safe and required.
        super().__init__(include_nonce=True)  # type: ignore[no-untyped-call]
        self.urls = tuple(urls)
        self.timeout = timeout
        self.used_url: str | None = None
        self.failures: list[dict[str, str]] = []

    @property
    def exhausted(self) -> bool:
        """True when at least one request failed and none succeeded."""
        return self.used_url is None and bool(self.failures)

    async def async_timestamp(self, message_digest: bytes, md_algorithm: str) -> Any:
        for url in self.urls:
            client = HTTPTimeStamper(url, timeout=self.timeout)
            try:
                token = await client.async_timestamp(message_digest, md_algorithm)
            except Exception as exc:  # network, HTTP status or a malformed TSA reply
                self.failures.append({"url": url, "error": type(exc).__name__})
                continue
            self.used_url = url
            return token
        raise TsaChainFailed(list(self.failures))
