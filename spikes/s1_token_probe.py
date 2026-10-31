"""Chef PDF - real USB token probe (spike S1 / T1.08).

Run on your own machine with your real token plugged in:

    cd spikes
    uv sync
    uv run python s1_token_probe.py                 # scan known driver paths, list tokens/certs (no PIN)
    uv run python s1_token_probe.py --lib PATH      # probe one PKCS#11 library
    uv run python s1_token_probe.py --lib PATH --sign sample.pdf [--tsa URL] [--trust-root root.cer]

Safety rules built in:
  * Listing never asks for or sends a PIN.
  * The PIN is asked once (hidden input). A wrong PIN is NEVER retried automatically.
  * Before login the token's PIN flags are read; if the token reports "final try"
    you must type an explicit confirmation, if it reports "locked" we stop.
  * Every library is loaded in a child process with a timeout, so a broken
    driver cannot hang or crash the probe.
  * The JSON report masks MST/CCCD digits by default (--no-redact to keep them).

User-facing messages are Vietnamese; code is English.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import platform
import re
import subprocess
import sys
import time
from pathlib import Path

# --------------------------------------------------------------------------- candidates
# Names come from docs/TOKENS.md and public install guides. NOT verified on real
# tokens; the point of this probe is to verify them.
WIN_NAMES = [
    "viettel-ca_v6.dll", "viettel-ca_v5.dll", "viettel-ca_v4.dll", "viettel-ca_v3.dll",
    "viettel-ca_v1.dll", "Viettel-ca.dll",
    "eTPKCS11.dll",          # SafeNet eToken (Ban Cơ yếu tokens before 2021)
    "bit4xpki.dll",          # Bit4id (Ban Cơ yếu tokens from 2021)
    "eps2003csp11.dll", "eps2003csp11v2.dll",  # Feitian ePass2003 (belief)
    "ShuttleCsp11_3003.dll",  # Feitian ePass3003 (belief)
    "IDPrimePKCS11.dll",     # Thales IDPrime
    "opensc-pkcs11.dll",
]
WIN_GLOBS = ["*viettel*.dll", "*vnpt*.dll", "*fpt*ca*.dll", "*misa*.dll", "*bkav*.dll",
             "*newtel*.dll", "*smartsign*.dll", "*vgca*.dll", "*efy*.dll", "*cmc*ca*.dll",
             "*safeca*.dll", "*fastca*.dll", "*trustca*.dll", "*pkcs11*.dll", "*p11*.dll"]
WIN_DIRS = [os.path.expandvars(r"%WINDIR%\System32"), os.path.expandvars(r"%WINDIR%\SysWOW64"),
            r"C:\Program Files\OpenSC Project\OpenSC\pkcs11"]

MAC_PATHS = [
    "/usr/local/lib/libeTPkcs11.dylib",
    "/Library/Frameworks/eToken.framework/Versions/A/libeToken.dylib",
    "/usr/local/lib/libbit4xpki.dylib",
    "/usr/local/lib/libcastle.1.0.0.dylib",
    "/Library/OpenSC/lib/opensc-pkcs11.so",
    "/opt/homebrew/lib/opensc-pkcs11.so",
    "/usr/local/lib/opensc-pkcs11.so",
]
MAC_GLOBS = ["/usr/local/lib/*pkcs11*.dylib", "/usr/local/lib/*p11*.dylib", "/usr/local/lib/*ca*.dylib",
             "/Library/Application Support/*/*pkcs11*.dylib", "/Applications/*/Contents/*/*pkcs11*.dylib",
             "/Applications/*/Contents/*/*p11*.dylib"]

LINUX_PATHS = [
    "/usr/lib/libeTPkcs11.so", "/usr/lib/libbit4xpki.so", "/usr/lib/libcastle.so.1.0.0",
    "/usr/lib/libePass2003.so", "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
    "/usr/lib/opensc-pkcs11.so", "/usr/lib64/opensc-pkcs11.so",
]
LINUX_GLOBS = ["/usr/lib/*pkcs11*.so*", "/usr/local/lib/*pkcs11*.so*", "/usr/lib/x86_64-linux-gnu/pkcs11/*.so",
               "/usr/lib64/pkcs11/*.so", "/opt/*/lib/*pkcs11*.so*"]
SKIP_NAME = re.compile(r"(pkcs11-spy|p11-kit-trust|p11-kit-client|p11-kit-proxy|onepin)", re.I)

PIN_FLAG_NAMES = ("USER_PIN_COUNT_LOW", "USER_PIN_FINAL_TRY", "USER_PIN_LOCKED", "USER_PIN_TO_BE_CHANGED")
VN_ID_RE = re.compile(r"(MST|MNS|CMND|CCCD|HC|BHXH)\s*[:=]\s*([0-9A-Za-z\-]+)", re.I)


def candidate_libs() -> list[str]:
    found: list[str] = []
    system = platform.system()
    if system == "Windows":
        for d in WIN_DIRS:
            for n in WIN_NAMES:
                p = os.path.join(d, n)
                if os.path.isfile(p):
                    found.append(p)
            for g in WIN_GLOBS:
                found += glob.glob(os.path.join(d, g))
    elif system == "Darwin":
        found += [p for p in MAC_PATHS if os.path.isfile(p)]
        for g in MAC_GLOBS:
            found += glob.glob(g)
    else:
        found += [p for p in LINUX_PATHS if os.path.isfile(p)]
        for g in LINUX_GLOBS:
            found += glob.glob(g)
        # p11-kit registry lists installed modules on many distros
        for mod in glob.glob("/usr/share/p11-kit/modules/*.module") + glob.glob("/etc/pkcs11/modules/*.module"):
            for line in Path(mod).read_text(errors="ignore").splitlines():
                if line.strip().startswith("module:"):
                    m = line.split(":", 1)[1].strip()
                    if not os.path.isabs(m):
                        m = os.path.join("/usr/lib/x86_64-linux-gnu/pkcs11", m)
                    if os.path.isfile(m):
                        found.append(m)
    seen, out = set(), []
    for p in found:
        rp = os.path.realpath(p)
        if rp not in seen and not SKIP_NAME.search(os.path.basename(p)):
            seen.add(rp)
            out.append(p)
    return out


def redact(s: str, enabled: bool) -> str:
    if not enabled:
        return s
    return VN_ID_RE.sub(lambda m: f"{m.group(1)}:{'*' * max(0, len(m.group(2)) - 3)}{m.group(2)[-3:]}", s)


# --------------------------------------------------------------------------- child: probe one lib
def probe_one(lib_path: str) -> dict:
    """Runs in a child process. Lists slots/tokens/certs without logging in."""
    import pkcs11
    from cryptography import x509
    from pkcs11 import Attribute, Mechanism, ObjectClass, TokenFlag

    t = time.perf_counter()
    lib = pkcs11.lib(lib_path)
    res: dict = {
        "lib": lib_path,
        "load_ms": round((time.perf_counter() - t) * 1000),
        "manufacturer": lib.manufacturer_id,
        "description": lib.library_description,
        "cryptoki_version": ".".join(map(str, lib.cryptoki_version)),
        "slots": [],
    }
    for slot in lib.get_slots(token_present=False):
        s: dict = {"slot_id": slot.slot_id, "description": slot.slot_description.strip(),
                   "flags": [f.name for f in type(slot.flags) if f and slot.flags & f]}
        try:
            tok = slot.get_token()
        except Exception as e:  # noqa: BLE001 - empty reader, etc.
            s["token"] = f"(không có token: {type(e).__name__})"
            res["slots"].append(s)
            continue
        flags = [f.name for f in TokenFlag if f and tok.flags & f]
        s["token"] = {
            "label": tok.label.strip(), "manufacturer": tok.manufacturer_id.strip(),
            "model": tok.model.strip(),
            "serial": tok.serial.decode(errors="replace").strip() if isinstance(tok.serial, bytes) else str(tok.serial),
            "flags": flags,
            "pin_flags": [f for f in flags if f in PIN_FLAG_NAMES],
        }
        try:
            mechs = slot.get_mechanisms()
            s["token"]["mech_sha256_rsa_pkcs"] = Mechanism.SHA256_RSA_PKCS in mechs
            s["token"]["mech_rsa_pkcs_raw"] = Mechanism.RSA_PKCS in mechs
            s["token"]["mech_ecdsa"] = Mechanism.ECDSA in mechs
            s["token"]["mech_sha256_rsa_pss"] = Mechanism.SHA256_RSA_PKCS_PSS in mechs
        except Exception as e:  # noqa: BLE001
            s["token"]["mechanisms_error"] = repr(e)
        if "TOKEN_INITIALIZED" not in flags:
            res["slots"].append(s)
            continue
        certs = []
        try:
            with tok.open() as sess:  # public session: no PIN
                for obj in sess.get_objects({Attribute.CLASS: ObjectClass.CERTIFICATE}):
                    try:
                        der = obj[Attribute.VALUE]
                        c = x509.load_der_x509_certificate(der)
                        try:
                            is_ca = c.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
                        except x509.ExtensionNotFound:
                            is_ca = False
                        try:
                            label = obj[Attribute.LABEL]
                        except Exception:  # noqa: BLE001
                            label = None
                        certs.append({
                            "label": label,
                            "id": obj[Attribute.ID].hex(),
                            "subject": c.subject.rfc4514_string(),
                            "issuer": c.issuer.rfc4514_string(),
                            "not_before": c.not_valid_before_utc.isoformat(),
                            "not_after": c.not_valid_after_utc.isoformat(),
                            "is_ca": is_ca,
                            "key_type": type(c.public_key()).__name__,
                            "sig_alg": c.signature_algorithm_oid._name,
                        })
                    except Exception as e:  # noqa: BLE001
                        certs.append({"error": repr(e)})
                s["token"]["private_keys_visible_without_login"] = len(
                    list(sess.get_objects({Attribute.CLASS: ObjectClass.PRIVATE_KEY})))
        except Exception as e:  # noqa: BLE001
            s["token"]["open_session_error"] = repr(e)
        s["token"]["certs"] = certs
        res["slots"].append(s)
    return res


def probe_in_child(lib_path: str, timeout: int = 30) -> dict:
    try:
        p = subprocess.run([sys.executable, __file__, "--_child", lib_path],
                           capture_output=True, text=True, timeout=timeout, encoding="utf-8")
    except subprocess.TimeoutExpired:
        return {"lib": lib_path, "error": f"quá thời gian {timeout}s (driver treo?)"}
    if p.returncode != 0:
        tail = (p.stderr or "").strip().splitlines()[-1:] or [f"exit code {p.returncode}"]
        return {"lib": lib_path, "error": tail[0][:300]}
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"lib": lib_path, "error": "không đọc được kết quả", "stdout": p.stdout[:300]}


# --------------------------------------------------------------------------- signing
def sign_sample(args, report: dict) -> None:
    import getpass

    import pkcs11
    from pkcs11 import TokenFlag
    from pkcs11.exceptions import PinIncorrect, PinLenRange, PinLocked
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import signers, timestamps
    from pyhanko.sign.fields import SigSeedSubFilter
    from pyhanko.sign.pkcs11 import PKCS11Signer

    lib = pkcs11.lib(args.lib)
    slots = [s for s in lib.get_slots(token_present=True)]
    if args.slot is not None:
        slots = [s for s in slots if s.slot_id == args.slot]
    tokens = []
    for s in slots:
        try:
            t = s.get_token()
            if t.flags & TokenFlag.TOKEN_INITIALIZED:
                tokens.append(t)
        except Exception:  # noqa: BLE001
            pass
    if len(tokens) != 1:
        print(f"Cần đúng 1 token, đang thấy {len(tokens)}. Dùng --slot để chọn.")
        return
    tok = tokens[0]
    flags = tok.flags
    print(f"\nToken: {tok.label.strip()} ({tok.manufacturer_id.strip()} {tok.model.strip()})")
    if flags & TokenFlag.USER_PIN_LOCKED:
        print("⛔ Token báo PIN ĐÃ BỊ KHÓA. Dừng lại. Liên hệ CA để mở khóa (cần PUK/SO PIN).")
        return
    if flags & TokenFlag.USER_PIN_FINAL_TRY:
        print("⚠️  Token báo đây là LẦN THỬ PIN CUỐI CÙNG. Nhập sai lần này token sẽ bị khóa.")
        if input('Gõ chính xác "TOI HIEU" để tiếp tục: ').strip() != "TOI HIEU":
            print("Đã hủy.")
            return
    elif flags & TokenFlag.USER_PIN_COUNT_LOW:
        print("⚠️  Token báo đã có lần nhập PIN sai trước đó. Hãy cẩn thận, token có thể khóa sau vài lần sai.")
    protected = bool(flags & TokenFlag.PROTECTED_AUTHENTICATION_PATH)
    if protected:
        print("Token dùng đường nhập PIN riêng (bàn phím trên token hoặc cửa sổ của driver).")
        pin = pkcs11.PROTECTED_AUTH
    else:
        print("Nhập PIN 1 lần. Nếu sai, chương trình dừng ngay và KHÔNG thử lại.")
        pin = getpass.getpass("PIN token: ")
        if not pin:
            print("PIN trống, hủy.")
            return
    t0 = time.perf_counter()
    try:
        session = tok.open(user_pin=pin)
    except PinIncorrect:
        after = lib.get_token(token_serial=tok.serial).flags if tok.serial else 0
        print("❌ PIN SAI. Chương trình dừng, KHÔNG thử lại.")
        if after & TokenFlag.USER_PIN_FINAL_TRY:
            print("⚠️  Token báo lần sau là LẦN CUỐI. Đừng thử thêm nếu không chắc PIN.")
        elif after & TokenFlag.USER_PIN_LOCKED:
            print("⛔ Token đã bị khóa.")
        report["sign"] = {"result": "PIN_INCORRECT", "pin_flags_after": int(after)}
        return
    except (PinLocked, PinLenRange) as e:
        print(f"❌ {type(e).__name__}. Dừng.")
        report["sign"] = {"result": type(e).__name__}
        return
    finally:
        pin = None  # noqa: F841 - drop reference to the PIN
    login_ms = round((time.perf_counter() - t0) * 1000)
    out = {"login_ms": login_ms, "protected_auth_path": protected}
    try:
        cert_id = bytes.fromhex(args.cert_id) if args.cert_id else None
        signer = PKCS11Signer(session, cert_id=cert_id, key_id=cert_id, other_certs_to_pull=None,
                              use_raw_mechanism=args.raw)
        if cert_id is None:
            # Pick the first non-CA certificate that has a matching private key.
            from pkcs11 import Attribute, ObjectClass
            keys = {k[Attribute.ID] for k in session.get_objects({Attribute.CLASS: ObjectClass.PRIVATE_KEY})}
            out["private_key_ids"] = [k.hex() for k in keys]
            if len(keys) != 1:
                print(f"Token có {len(keys)} khóa riêng; dùng --cert-id <hex> để chọn: {[k.hex() for k in keys]}")
                return
            kid = next(iter(keys))
            signer = PKCS11Signer(session, cert_id=kid, key_id=kid, other_certs_to_pull=None,
                                  use_raw_mechanism=args.raw)
        cert = signer.signing_cert
        print(f"Chứng thư ký: {cert.subject.human_friendly}")
        src = Path(args.sign)
        dst = src.with_name(src.stem + "_da-ky.pdf")
        ts = timestamps.HTTPTimeStamper(args.tsa) if args.tsa else None
        meta = signers.PdfSignatureMetadata(field_name="ChefProbe", md_algorithm="sha256",
                                            subfilter=SigSeedSubFilter.PADES,
                                            reason="Thử ký bằng Chef PDF token probe", location="Việt Nam")
        t1 = time.perf_counter()
        with src.open("rb") as inf, dst.open("wb") as outf:
            w = IncrementalPdfFileWriter(inf, strict=False)
            signers.PdfSigner(meta, signer, timestamper=ts).sign_pdf(w, output=outf)
        out["sign_ms"] = round((time.perf_counter() - t1) * 1000)
        out["output"] = str(dst)
        print(f"✅ Đã ký: {dst}  ({out['sign_ms']} ms)")
        out["validation"] = validate_output(dst, args.trust_root)
        print(f"Kiểm tra: {out['validation']}")
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
        print(f"❌ Lỗi khi ký: {out['error']}")
        if "Mechanism" in type(e).__name__ or "mechanism" in str(e).lower():
            print("Gợi ý: chạy lại với --raw (ký bằng CKM_RSA_PKCS, băm trên máy).")
    finally:
        session.close()
    report["sign"] = out


def validate_output(path: Path, trust_root: str | None) -> dict:
    from asn1crypto import pem
    from asn1crypto import x509 as ax
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    roots = []
    if trust_root:
        data = Path(trust_root).read_bytes()
        if pem.detect(data):
            _, _, data = pem.unarmor(data)
        roots.append(ax.Certificate.load(data))
    vc = ValidationContext(trust_roots=roots or None, allow_fetching=True)
    with path.open("rb") as f:
        r = PdfFileReader(f)
        st = validate_pdf_signature(r.embedded_signatures[-1], vc)
        return {"intact": st.intact, "valid": st.valid, "trusted": st.trusted,
                "timestamp": st.timestamp_validity is not None,
                "summary": st.summary()}


def probe_tsas(urls: list[str]) -> dict:
    import asyncio
    import hashlib

    from pyhanko.sign import timestamps

    res = {}
    for u in urls:
        t = time.perf_counter()
        try:
            asyncio.run(timestamps.HTTPTimeStamper(u, timeout=10).async_timestamp(
                hashlib.sha256(b"chef").digest(), "sha256"))
            res[u] = f"OK {round((time.perf_counter() - t) * 1000)} ms"
        except Exception as e:  # noqa: BLE001
            res[u] = f"FAIL {type(e).__name__}: {str(e)[:100]}"
        print(f"  TSA {u}: {res[u]}")
    return res


# --------------------------------------------------------------------------- main
def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--_child":
        print(json.dumps(probe_one(sys.argv[2]), ensure_ascii=False))
        return
    ap = argparse.ArgumentParser(description="Chef PDF: dò USB token PKCS#11 (không cần PIN), tùy chọn ký thử.")
    ap.add_argument("--lib", help="Đường dẫn thư viện PKCS#11 (.dll/.so/.dylib). Bỏ trống = tự quét.")
    ap.add_argument("--slot", type=int, help="slot_id khi có nhiều token")
    ap.add_argument("--sign", metavar="PDF", help="Ký thử file PDF này (sẽ hỏi PIN 1 lần)")
    ap.add_argument("--cert-id", help="CKA_ID (hex) của chứng thư/khóa nếu token có nhiều")
    ap.add_argument("--raw", action="store_true", help="Ký bằng CKM_RSA_PKCS (băm trên máy)")
    ap.add_argument("--tsa", help="URL máy chủ dấu thời gian để ký B-T")
    ap.add_argument("--probe-tsa", nargs="*", metavar="URL", help="Thử các TSA (mặc định: danh sách phổ biến)")
    ap.add_argument("--trust-root", help="File Root CA (.cer/.crt) để kiểm tra tin cậy sau khi ký")
    ap.add_argument("--no-redact", action="store_true", help="Không che MST/CCCD trong báo cáo JSON")
    ap.add_argument("--out", default="token_probe_report.json")
    args = ap.parse_args()

    report: dict = {"os": f"{platform.system()} {platform.release()} {platform.machine()}",
                    "python": sys.version.split()[0], "python_bits": 64 if sys.maxsize > 2**32 else 32}
    libs = [args.lib] if args.lib else candidate_libs()
    print(f"Hệ điều hành: {report['os']}, Python {report['python']} ({report['python_bits']}-bit)")
    if not libs:
        print("Không tìm thấy thư viện PKCS#11 nào ở các đường dẫn quen thuộc. Dùng --lib để chỉ định.")
    report["libraries"] = []
    for lib in libs:
        print(f"\n== {lib}")
        r = probe_in_child(lib)
        report["libraries"].append(r)
        if "error" in r:
            print(f"   lỗi: {r['error']}")
            continue
        print(f"   {r['manufacturer']} | {r['description']} | Cryptoki {r['cryptoki_version']} | nạp {r['load_ms']} ms")
        for s in r["slots"]:
            tok = s.get("token")
            if not isinstance(tok, dict):
                print(f"   slot {s['slot_id']}: {s['description']} {tok}")
                continue
            print(f"   slot {s['slot_id']}: token '{tok['label']}' {tok['manufacturer']} {tok['model']} SN {tok['serial']}")
            print(f"      cờ PIN: {tok['pin_flags'] or 'bình thường'}; "
                  f"SHA256_RSA_PKCS={tok.get('mech_sha256_rsa_pkcs')} RSA_PKCS(raw)={tok.get('mech_rsa_pkcs_raw')}")
            if "USER_PIN_FINAL_TRY" in tok["pin_flags"] or "USER_PIN_LOCKED" in tok["pin_flags"]:
                print("      ⚠️  TOKEN SẮP KHÓA / ĐÃ KHÓA. Đừng nhập PIN thử.")
            for c in tok.get("certs", []):
                if "error" in c:
                    print(f"      cert lỗi: {c['error']}")
                    continue
                kind = "CA " if c["is_ca"] else "ký"
                print(f"      [{kind}] id={c['id']} hạn đến {c['not_after'][:10]} | {redact(c['subject'], not args.no_redact)}")

    if args.probe_tsa is not None:
        urls = args.probe_tsa or ["http://timestamp.digicert.com", "http://timestamp.sectigo.com",
                                  "https://freetsa.org/tsr", "http://ts.ssl.com"]
        print("\nThử máy chủ dấu thời gian:")
        report["tsa"] = probe_tsas(urls)

    if args.sign:
        if not args.lib:
            print("\n--sign cần --lib (chọn đúng thư viện của token).")
        else:
            sign_sample(args, report)

    text = json.dumps(report, ensure_ascii=False, indent=2)
    Path(args.out).write_text(redact(text, not args.no_redact), encoding="utf-8")
    print(f"\nĐã ghi báo cáo: {args.out} (MST/CCCD đã được che{' — TẮT che' if args.no_redact else ''}).")


if __name__ == "__main__":
    main()
