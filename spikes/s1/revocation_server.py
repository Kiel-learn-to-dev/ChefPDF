"""Tiny local PKI services for the test chain: CRL, OCSP and RFC 3161 TSA.

  GET  /crl/root.crl, /crl/inter.crl   -> DER CRLs
  GET  /certs/root.crt, /certs/inter.crt
  POST /ocsp                            -> OCSP response signed by the delegated responder
  POST /tsa                             -> RFC 3161 timestamp (pyHanko DummyTimeStamper)

Usage in-process:  with serve(): ...   (runs in a daemon thread)
Standalone:        uv run python -m s1.revocation_server
"""

from __future__ import annotations

import base64
import contextlib
import datetime as dt
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

from asn1crypto import keys as asn1_keys
from asn1crypto import tsp
from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509 import ocsp
from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper

from .common import PKI, REVOCATION_HOST, REVOCATION_PORT

STATS: dict[str, int] = {"ocsp": 0, "crl": 0, "tsa": 0, "certs": 0}


def _load(name: str):
    cert = x509.load_pem_x509_certificate((PKI / f"{name}.crt.pem").read_bytes())
    key_path = PKI / f"{name}.key.pem"
    key = serialization.load_pem_private_key(key_path.read_bytes(), None) if key_path.exists() else None
    return cert, key


class _State:
    def __init__(self) -> None:
        self.inter, _ = _load("inter")
        self.ocsp_cert, self.ocsp_key = _load("ocsp")
        self.revoked = set(json.loads((PKI / "revoked.json").read_text())["serials"])
        self.tsa = DummyTimeStamper(
            tsa_cert=asn1_x509.Certificate.load((PKI / "tsa.crt.der").read_bytes()),
            tsa_key=asn1_keys.PrivateKeyInfo.load((PKI / "tsa.key.der").read_bytes()),
            certs_to_embed=None,
        )

    def ocsp_response(self, der_req: bytes) -> bytes:
        req = ocsp.load_der_ocsp_request(der_req)
        now = dt.datetime.now(dt.UTC)
        # We only issue status for certs issued by the intermediate.
        serial = req.serial_number
        # Need the subject cert object for the builder; look it up by serial.
        subject = None
        for n in ("signer", "signer2", "revoked"):
            c, _ = _load(n)
            if c.serial_number == serial:
                subject = c
        if subject is None:
            return ocsp.OCSPResponseBuilder.build_unsuccessful(
                ocsp.OCSPResponseStatus.UNAUTHORIZED
            ).public_bytes(serialization.Encoding.DER)
        if serial in self.revoked:
            status, rev_time, reason = (
                ocsp.OCSPCertStatus.REVOKED, now - dt.timedelta(minutes=30), None
            )
        else:
            status, rev_time, reason = ocsp.OCSPCertStatus.GOOD, None, None
        b = (
            ocsp.OCSPResponseBuilder()
            .add_response(
                cert=subject, issuer=self.inter, algorithm=req.hash_algorithm,
                cert_status=status, this_update=now - dt.timedelta(minutes=1),
                next_update=now + dt.timedelta(hours=12),
                revocation_time=rev_time, revocation_reason=reason,
            )
            .responder_id(ocsp.OCSPResponderEncoding.HASH, self.ocsp_cert)
            .certificates([self.ocsp_cert])
        )
        for ext in req.extensions:
            if isinstance(ext.value, x509.OCSPNonce):
                b = b.add_extension(ext.value, critical=False)
        return b.sign(self.ocsp_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)

    def tsa_response(self, der_req: bytes) -> bytes:
        req = tsp.TimeStampReq.load(der_req)
        return self.tsa.request_tsa_response(req).dump()


def _handler(state: _State):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, body: bytes, ctype: str, code: int = 200):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            p = self.path
            if p.startswith("/crl/"):
                STATS["crl"] += 1
                f = PKI / p.removeprefix("/crl/")
                return self._send(f.read_bytes(), "application/pkix-crl") if f.exists() else self._send(b"", "text/plain", 404)
            if p.startswith("/certs/"):
                STATS["certs"] += 1
                f = PKI / (p.removeprefix("/certs/").removesuffix(".crt") + ".crt.der")
                return self._send(f.read_bytes(), "application/pkix-cert") if f.exists() else self._send(b"", "text/plain", 404)
            if p.startswith("/ocsp/"):
                STATS["ocsp"] += 1
                der = base64.b64decode(unquote(p.removeprefix("/ocsp/")))
                return self._send(state.ocsp_response(der), "application/ocsp-response")
            self._send(b"not found", "text/plain", 404)

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.path.startswith("/ocsp"):
                STATS["ocsp"] += 1
                return self._send(state.ocsp_response(body), "application/ocsp-response")
            if self.path.startswith("/tsa"):
                STATS["tsa"] += 1
                return self._send(state.tsa_response(body), "application/timestamp-reply")
            self._send(b"not found", "text/plain", 404)

    return H


@contextlib.contextmanager
def serve():
    srv = ThreadingHTTPServer((REVOCATION_HOST, REVOCATION_PORT), _handler(_State()))
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield srv
    finally:
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    print(f"Serving on http://{REVOCATION_HOST}:{REVOCATION_PORT} (Ctrl+C to stop)")
    ThreadingHTTPServer((REVOCATION_HOST, REVOCATION_PORT), _handler(_State())).serve_forever()
