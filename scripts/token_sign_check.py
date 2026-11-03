#!/usr/bin/env python3
"""Sign a sample PDF with a real USB token through the app's own core, then verify it.

Run from the repo root, in a terminal where YOU type the PIN (it is asked once, never shown,
never stored, never printed):

    cd core
    uv run python ../scripts/token_sign_check.py --trust-root PATH_TO_ROOT_AND_INTERMEDIATE_FOLDER

It stops without using the PIN when the token reports a locked or last-try state. Output goes to
./token-check-out/ (the signed PDF to open in Adobe Reader / Foxit, and a JSON summary).
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op


def run(op: str, params: dict[str, Any], **ctx_args: Any) -> Any:
    spec = get_op(op)
    if spec is None:
        raise SystemExit(f"operation {op} not found")
    ctx = OpContext(job_id="token-check", work_dir=Path(tempfile.mkdtemp()), **ctx_args)
    out = spec.run(ctx, spec.params_model.model_validate(params))
    return out.data, ctx


def sample_pdf(path: Path) -> None:
    from reportlab.pdfgen import canvas

    pdf = canvas.Canvas(str(path), pagesize=(595, 842))
    pdf.setFont("Helvetica", 14)
    pdf.drawString(72, 760, "Chef PDF token signing check")
    pdf.drawString(72, 740, "This page exists only to be signed.")
    pdf.showPage()
    pdf.save()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", help="PKCS#11 library; default: the first driver found")
    parser.add_argument("--cert-id", help="CKA_ID (hex); default: the only valid signer cert")
    parser.add_argument(
        "--trust-root", action="append", default=[], help="root/intermediate file or folder"
    )
    parser.add_argument("--tsa", help="timestamp server URL (adds a timestamp, level B-T)")
    parser.add_argument("--out", default="token-check-out", help="output folder")
    args = parser.parse_args()

    load_builtin_ops()
    out_dir = Path(args.out).absolute()
    out_dir.mkdir(parents=True, exist_ok=True)

    scan, _ = run("sign.driverScan", {"probe": True})
    found = [d for d in scan["drivers"] if d["exists"] and d.get("probe", {}).get("status") == "ok"]
    module = args.module or (found[0]["path"] if found else None)
    if not module:
        print("No working PKCS#11 driver found.")
        return 2
    print(f"Driver: {module}")

    listing, _ = run("sign.listTokens", {"modulePath": module})
    if not listing["tokens"]:
        print("No token in the driver.")
        return 2
    token = listing["tokens"][0]
    print(f"Token: {token['label']} ({token['model']}), PIN state: {token['pinState']}")
    if token["pinState"] != "ok":
        print("The token is not in a normal PIN state; stopping before the PIN is used.")
        return 3

    certs = [c for c in token["certificates"] if not c["isCa"] and not c["cert"]["expired"]]
    if args.cert_id:
        certs = [c for c in certs if c["ckaId"] == args.cert_id.lower()]
    if len(certs) != 1:
        print("Choose the signer certificate with --cert-id; valid candidates:")
        for c in certs:
            print(f"  {c['ckaId']}  valid until {c['cert']['notAfter']}")
        return 2
    cert = certs[0]
    print(f"Certificate: {cert['ckaId'][:8]}…  valid until {cert['cert']['notAfter']}")

    source = out_dir / "mau.pdf"
    sample_pdf(source)
    signed = out_dir / "mau_da-ky.pdf"
    pin = getpass.getpass("PIN (asked once, not shown): ")
    params: dict[str, Any] = {
        "modulePath": module,
        "slotId": token["slotId"],
        "certId": cert["ckaId"],
        "pin": pin,
        "reason": "Token signing check",
    }
    if args.tsa:
        params.update({"level": "B-T", "tsaUrls": [args.tsa]})
    try:
        data, _ctx = run(
            "sign.padesToken",
            params,
            input_path=source,
            result_path=signed,
        )
    except Exception as exc:  # report, never retry: a wrong PIN counts against the token
        print(f"Signing failed (not retried): {type(exc).__name__}: {exc}")
        return 4
    finally:
        pin = ""
    print(f"Signed: {signed}  (field {data['fieldName']}, level {data['level']})")

    report, _ = run("sign.verifyFile", {"path": str(signed), "trustRootPaths": args.trust_root})
    summary = json.dumps(report, ensure_ascii=False, indent=2, default=str)
    (out_dir / "verify.json").write_text(summary, encoding="utf-8")
    print("Verification result saved to verify.json")
    for sig in report.get("signatures", []):
        print(
            f"  status: {sig['status']} | reasons: {sig['reasons']} | level: {sig['level']} | "
            f"whole document: {sig['coversWholeDocument']}"
        )
        print(f"  {sig['summaryVi']}")
        for row in sig["chain"]:
            print(f"    chain: trusted={row['trusted']}  {row['subject'][:70]}")
    print(f"\nNow open {signed} in Adobe Acrobat Reader and Foxit, and send the screenshots.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
