"""Validate every signed PDF in s1/out with pyHanko, using the test root as trust anchor.

1. Online validation (local OCSP/CRL/TSA services running), hard-fail revocation.
2. Offline LTV check: services stopped, only the DSS embedded in the file is used.
3. AdES LTA validation (ETSI EN 319 102-1) of the B-LTA file, now and simulated 3 years later.
4. Parse MST/CCCD back out of the signer certificate.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import re

from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.x509.oid import ObjectIdentifier
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import read_certification_data, validate_pdf_signature, validate_pdf_timestamp
from pyhanko.sign.validation.ades import ades_lta_validation, simulate_future_ades_lta_validation
from pyhanko.sign.validation.dss import DocumentSecurityStore
from pyhanko.sign.validation.policy_decl import (
    PdfSignatureValidationSpec,
    RevinfoOnlineFetchingRule,
    RevocationInfoGatheringSpec,
    SignatureValidationSpec,
)
from pyhanko_certvalidator import ValidationContext
from pyhanko_certvalidator.context import CertValidationPolicySpec
from pyhanko_certvalidator.policy_decl import REQUIRE_REVINFO, CertRevTrustPolicy
from pyhanko_certvalidator.registry import SimpleTrustManager

from . import revocation_server
from .common import OUT, PKI

UID_OID = ObjectIdentifier("0.9.2342.19200300.100.1.1")
# Prefixes seen on Vietnamese certs (public CAs + Ban Cơ yếu). Belief, not verified on
# every CA: MST (tax code), CMND/CCCD (ID card), HC (passport), MNS (budget unit code).
VN_ID_RE = re.compile(r"^\s*(MST|MNS|CMND|CCCD|HC|BHXH|CDT)\s*[:=]\s*([0-9A-Za-z\-]+)\s*$", re.I)


def parse_vn_ids(cert: x509.Certificate) -> dict[str, list[str]]:
    """Extract MST/CCCD/... from the subject. Looks at UID first, then any attribute
    whose value matches PREFIX:VALUE (some CAs put it in OU/CN/serialNumber)."""
    found: dict[str, list[str]] = {}
    for attr in cert.subject:
        m = VN_ID_RE.match(str(attr.value))
        if m:
            found.setdefault(m.group(1).upper(), []).append(m.group(2))
    return found


def root() -> asn1_x509.Certificate:
    return asn1_x509.Certificate.load((PKI / "root.crt.der").read_bytes())


def summarize(st) -> dict:
    d = {
        "intact": st.intact,
        "valid": st.valid,
        "trusted": st.trusted,
        "bottom_line": st.bottom_line,
        "revoked": getattr(st, "revoked", None),
        "coverage": st.coverage.name if st.coverage else None,
        "modification_level": st.modification_level.name if st.modification_level else None,
        "docmdp_ok": st.docmdp_ok,
        "signer": st.signing_cert.subject.human_friendly if st.signing_cert else None,
        "has_signature_timestamp": st.timestamp_validity is not None,
    }
    if st.timestamp_validity is not None:
        tv = st.timestamp_validity
        d["timestamp"] = {"trusted": tv.trusted, "intact": tv.intact, "time": tv.timestamp.isoformat()}
    return d


def pades_level(r: PdfFileReader, has_ts: bool) -> str:
    has_dss = "/DSS" in r.root
    doc_ts = len(r.embedded_timestamp_signatures)
    if has_dss and doc_ts:
        return "B-LTA"
    if has_dss and has_ts:
        return "B-LT"
    if has_ts:
        return "B-T"
    return "B-B"


def validate_online(files) -> dict:
    res = {}
    vc_kw = dict(trust_roots=[root()], allow_fetching=True, revocation_mode="hard-fail")
    for f in files:
        with f.open("rb") as inf:
            r = PdfFileReader(inf)
            sigs = []
            for emb in r.embedded_regular_signatures:
                st = validate_pdf_signature(emb, ValidationContext(**vc_kw),
                                            ts_validation_context=ValidationContext(**vc_kw))
                s = summarize(st)
                s["field"] = emb.field_name
                s["pades_level_guess"] = pades_level(r, s["has_signature_timestamp"])
                s["vn_ids"] = parse_vn_ids(x509.load_der_x509_certificate(emb.signer_cert.dump()))
                sigs.append(s)
            for emb in r.embedded_timestamp_signatures:
                st = validate_pdf_timestamp(emb, validation_context=ValidationContext(**vc_kw))
                sigs.append({"field": emb.field_name, "doc_timestamp": True, "intact": st.intact,
                             "valid": st.valid, "trusted": st.trusted})
            cert = read_certification_data(r)
            res[f.name] = {"signatures": sigs,
                           "certification": cert.permission.name if cert else None}
    return res


def validate_offline_dss(files) -> dict:
    """No network: build the validation context purely from the file's DSS."""
    res = {}
    for f in files:
        with f.open("rb") as inf:
            r = PdfFileReader(inf)
            try:
                dss = DocumentSecurityStore.read_dss(r)
                vc = dss.as_validation_context(
                    {"trust_roots": [root()], "allow_fetching": False, "revocation_mode": "hard-fail"}
                )
                src = "DSS"
            except Exception:  # noqa: BLE001 - no DSS in file
                vc = ValidationContext(trust_roots=[root()], allow_fetching=False, revocation_mode="hard-fail",
                                       crls=[], ocsps=[])
                src = "no DSS"
            out = []
            for emb in r.embedded_regular_signatures:
                st = validate_pdf_signature(emb, vc)
                out.append({"field": emb.field_name, "src": src, "trusted": st.trusted,
                            "bottom_line": st.bottom_line})
            res[f.name] = out
    return res


def ades_lta(file) -> dict:
    spec = PdfSignatureValidationSpec(
        SignatureValidationSpec(
            cert_validation_policy=CertValidationPolicySpec(
                trust_manager=SimpleTrustManager.build(trust_roots=[root()]),
                revinfo_policy=CertRevTrustPolicy(REQUIRE_REVINFO),
            ),
            revinfo_gathering_policy=RevocationInfoGatheringSpec(
                online_fetching_rule=RevinfoOnlineFetchingRule.LOCAL_ONLY
            ),
        )
    )
    out = {}
    with file.open("rb") as inf:
        r = PdfFileReader(inf)
        emb = r.embedded_regular_signatures[0]
        now_res = asyncio.run(ades_lta_validation(emb, spec))
        out["now"] = {"indication": now_res.ades_subindic.status.name,
                      "subindication": now_res.ades_subindic.name,
                      "failure": now_res.failure_msg}
        future = dt.datetime.now(dt.UTC) + dt.timedelta(days=3 * 365)
        try:
            fut = asyncio.run(simulate_future_ades_lta_validation(emb, spec, future_validation_time=future))
            out["in_3_years"] = {"indication": fut.ades_subindic.status.name,
                                 "subindication": fut.ades_subindic.name, "failure": fut.failure_msg}
        except Exception as e:  # noqa: BLE001
            out["in_3_years"] = f"error: {type(e).__name__}: {str(e)[:200]}"
    return out


def main() -> None:
    # pyhanko_certvalidator logs full tracebacks for expected failures (revoked cert).
    logging.basicConfig(level=logging.CRITICAL)
    files = sorted(p for p in OUT.glob("*.pdf") if not p.name.startswith(("_", "input")))
    report: dict = {}
    with revocation_server.serve():
        report["online"] = validate_online(files)
    report["offline_dss_only"] = validate_offline_dss(files)
    try:
        report["ades_lta_d_blta"] = ades_lta(OUT / "d_blta.pdf")
    except Exception as e:  # noqa: BLE001
        report["ades_lta_d_blta"] = f"error: {type(e).__name__}: {str(e)[:300]}"
    (OUT / "validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))

    print(f"{'file':38s} {'field':8s} lvl    intact valid trusted revoked mod_level           ts")
    for fn, d in report["online"].items():
        for s in d["signatures"]:
            if s.get("doc_timestamp"):
                print(f"{fn:38s} {s['field'][:8]:8s} docTS  {s['intact']!s:6s} {s['valid']!s:5s} {s['trusted']!s:7s}")
                continue
            print(f"{fn:38s} {s['field'][:8]:8s} {s['pades_level_guess']:6s} {s['intact']!s:6s} "
                  f"{s['valid']!s:5s} {s['trusted']!s:7s} {s['revoked']!s:7s} "
                  f"{s['modification_level']!s:19s} {s.get('timestamp', {}).get('trusted', '-')}")
        if d["certification"]:
            print(f"{'':38s} certification: {d['certification']}")
    print("\nOffline (no network, DSS only, hard-fail):")
    for fn, sigs in report["offline_dss_only"].items():
        for s in sigs:
            print(f"  {fn:38s} {s['field']:8s} {s['src']:7s} trusted={s['trusted']}")
    print("\nAdES LTA validation of d_blta.pdf:", json.dumps(report["ades_lta_d_blta"], ensure_ascii=False))
    ids = report["online"]["a_bb_invisible.pdf"]["signatures"][0]["vn_ids"]
    print("\nIDs parsed from signer cert:", ids)


if __name__ == "__main__":
    main()
