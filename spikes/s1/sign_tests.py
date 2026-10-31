"""S1 signing scenarios with pyHanko + PKCS#11 (SoftHSM2).

(a) invisible PAdES B-B
(b) visible signature, Vietnamese text + transparent PNG, two appearance strategies
(c) B-T: public TSAs probed, local RFC 3161 TSA used for the actual signature
(d) B-LT and B-LTA with local OCSP/CRL/TSA services
(e) two sequential signatures (incremental updates), pre-created empty fields
(f) certification signature (DocMDP) followed by an approval signature
(+) a signature with a revoked cert, a 10-file batch with one login

Writes PDFs to s1/out/ and timings to s1/out/results.json.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import time
from pathlib import Path

from asn1crypto import x509 as asn1_x509
from pyhanko.config.pkcs11 import TokenCriteria
from pyhanko.pdf_utils import layout
from pyhanko.pdf_utils.font.opentype import GlyphAccumulatorFactory
from pyhanko.pdf_utils.images import PdfImage
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.text import TextBoxStyle
from pyhanko.sign import fields, signers, timestamps
from pyhanko.sign.fields import MDPPerm, SigFieldSpec, SigSeedSubFilter
from pyhanko.sign.general import SigningError
from pyhanko.sign.pkcs11 import PKCS11Signer, open_pkcs11_session
from pyhanko.stamp import StaticStampStyle, TextStampStyle
from pyhanko_certvalidator import ValidationContext
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from common.fonts import bold_font, font_1000_upm, regular_font
from common.render import render_page

from . import revocation_server
from .common import BASE_URL, KEY_ID, KEY_LABEL, OUT, PKI, TOKEN_LABEL, USER_PIN, softhsm_env, softhsm_lib
from .samples import make_contract_pdf, make_signature_png

PUBLIC_TSAS = [
    # Commonly used public TSAs (international). Vietnamese CA TSA URLs are not
    # documented publicly; the probe script lets the owner add them.
    "http://timestamp.digicert.com",
    "https://freetsa.org/tsr",
    "http://timestamp.sectigo.com",
    "http://ts.ssl.com",
    "http://timestamp.globalsign.com/tsa/r6advanced1",
]

RESULTS: dict = {"timings_ms": {}, "notes": [], "public_tsa": {}}


def vn_date(d: dt.datetime) -> str:
    return f"Ngày {d.day:02d} tháng {d.month:02d} năm {d.year}"


def root_cert() -> asn1_x509.Certificate:
    return asn1_x509.Certificate.load((PKI / "root.crt.der").read_bytes())


def online_vc() -> ValidationContext:
    return ValidationContext(trust_roots=[root_cert()], allow_fetching=True, revocation_mode="hard-fail")


def timed(name: str):
    class _T:
        def __enter__(self):
            self.t = time.perf_counter()

        def __exit__(self, *a):
            RESULTS["timings_ms"][name] = round((time.perf_counter() - self.t) * 1000, 1)

    return _T()


def sign_file(src: Path, dst: Path, signer, meta, *, stamp_style=None, field_spec=None,
              timestamper=None, text_params=None, timing: str | None = None) -> None:
    with src.open("rb") as inf:
        w = IncrementalPdfFileWriter(inf, strict=False)
        pdf_signer = signers.PdfSigner(meta, signer, timestamper=timestamper,
                                       stamp_style=stamp_style, new_field_spec=field_spec)
        t = time.perf_counter()
        with dst.open("wb") as outf:
            pdf_signer.sign_pdf(w, output=outf, appearance_text_params=text_params)
        if timing:
            RESULTS["timings_ms"][timing] = round((time.perf_counter() - t) * 1000, 1)


# ---------------------------------------------------------------- appearances

def style_pyhanko_text(png: Path, *, fix_upm: bool = True) -> TextStampStyle:
    """Strategy B1: pyHanko built-in TextStampStyle + OpenType font + PNG background.
    fix_upm=False reproduces the pyHanko 0.38 unitsPerEm bug (see common.fonts)."""
    font = font_1000_upm(regular_font(), OUT) if fix_upm else regular_font()
    return TextStampStyle(
        stamp_text=(
            "Ký bởi: %(signer)s\nMST: %(mst)s\n%(date_vn)s\nLý do: %(reason)s\nNơi ký: %(location)s"
        ),
        text_box_style=TextBoxStyle(
            font=GlyphAccumulatorFactory(str(font), font_size=9),
            text_color=(0.75, 0.0, 0.0),
            leading=11,
        ),
        background=PdfImage(str(png)),
        background_opacity=1.0,
        background_layout=layout.SimpleBoxLayoutRule(
            x_align=layout.AxisAlignment.ALIGN_MIN,
            y_align=layout.AxisAlignment.ALIGN_MID,
            margins=layout.Margins(left=4, right=110, top=4, bottom=4),
        ),
        inner_content_layout=layout.SimpleBoxLayoutRule(
            x_align=layout.AxisAlignment.ALIGN_MAX,
            y_align=layout.AxisAlignment.ALIGN_MID,
            margins=layout.Margins.uniform(4),
            inner_content_scaling=layout.InnerScaling.SHRINK_TO_FIT,
        ),
        border_width=1,
        border_color=(0.75, 0.0, 0.0),
    )


def render_appearance_pdf(path: Path, w: float, h: float, png: Path, lines: list[str],
                          *, max_font=10.0, min_font=5.0, check_mark=True) -> float:
    """Strategy B2: draw the appearance ourselves with reportlab (full control:
    layout, wrapping, auto-shrink, check mark, transparency), then let pyHanko
    import it as a Form XObject. Returns the chosen font size."""
    pdfmetrics.registerFont(TTFont("AppVN", str(regular_font())))
    pdfmetrics.registerFont(TTFont("AppVNB", str(bold_font())))
    c = canvas.Canvas(str(path), pagesize=(w, h))
    img_w = w * 0.38
    c.drawImage(str(png), 2, 2, img_w - 4, h - 4, mask="auto", preserveAspectRatio=True, anchor="c")
    if check_mark:
        # Big translucent green check mark behind the text (I17, "Signature Valid" look)
        c.saveState()
        c.setFillColorRGB(0.1, 0.6, 0.2, alpha=0.25)
        c.setFont("AppVNB", h * 0.9)
        c.drawCentredString(img_w + (w - img_w) / 2, h * 0.12, "✓")
        c.restoreState()
    text_w = w - img_w - 6
    # Auto-shrink: largest size where wrapped text fits the box height.
    size = max_font
    while size >= min_font:
        wrapped = [wl for ln in lines for wl in simpleSplit(ln, "AppVN", size, text_w)]
        if len(wrapped) * size * 1.2 <= h - 4:
            break
        size -= 0.25
    y = h - 2 - size
    c.setFillColorRGB(0.75, 0, 0)
    for i, wl in enumerate(wrapped):
        c.setFont("AppVNB" if i == 0 else "AppVN", size)
        c.drawString(img_w + 3, y, wl)
        y -= size * 1.2
    c.setStrokeColorRGB(0.75, 0, 0)
    c.setLineWidth(0.8)
    c.rect(0.4, 0.4, w - 0.8, h - 0.8)
    c.showPage()
    c.save()
    return size


# ---------------------------------------------------------------- main

def probe_public_tsas() -> None:
    digest = hashlib.sha256(b"chef pdf spike").digest()
    for url in PUBLIC_TSAS:
        ts = timestamps.HTTPTimeStamper(url, timeout=8)
        t = time.perf_counter()
        try:
            asyncio.run(ts.async_timestamp(digest, "sha256"))
            RESULTS["public_tsa"][url] = f"OK {round((time.perf_counter() - t) * 1000)} ms"
        except Exception as e:  # noqa: BLE001 - we record any failure
            RESULTS["public_tsa"][url] = f"FAIL {type(e).__name__}: {str(e)[:120]}"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    softhsm_env()
    src = make_contract_pdf()
    png = make_signature_png()
    now = dt.datetime.now().astimezone()
    params = {
        "mst": "0101234567",
        "date_vn": vn_date(now),
        "reason": "Phê duyệt hợp đồng",
        "location": "Hà Nội",
    }

    with timed("open_session_and_login"):
        session = open_pkcs11_session(softhsm_lib(), token_criteria=TokenCriteria(label=TOKEN_LABEL),
                                      user_pin=USER_PIN)
    try:
        # Look up key+cert by CKA_ID (robust) and pull every cert on the token as chain.
        with timed("load_key_and_certs"):
            signer = PKCS11Signer(session, key_id=KEY_ID, cert_id=KEY_ID, other_certs_to_pull=None)
            _ = signer.signing_cert
        # UTF-8 labels: lookup by Vietnamese label must also work.
        try:
            s2 = PKCS11Signer(session, key_label=KEY_LABEL, cert_label=KEY_LABEL)
            RESULTS["notes"].append(f"lookup by UTF-8 label OK: {s2.signing_cert.subject.human_friendly}")
        except Exception as e:  # noqa: BLE001
            RESULTS["notes"].append(f"lookup by UTF-8 label FAILED: {e!r}")

        base = dict(md_algorithm="sha256", subfilter=SigSeedSubFilter.PADES,
                    reason=params["reason"], location=params["location"])

        # (a) invisible B-B
        a = OUT / "a_bb_invisible.pdf"
        sign_file(src, a, signer, signers.PdfSignatureMetadata(field_name="Sig_A", **base),
                  timing="a_sign_bb_invisible")

        # (b1) visible, pyHanko TextStampStyle (with and without the UPM workaround)
        b1 = OUT / "b1_visible_pyhanko_style.pdf"
        sign_file(src, b1, signer, signers.PdfSignatureMetadata(field_name="Sig_B1", **base),
                  stamp_style=style_pyhanko_text(png),
                  field_spec=SigFieldSpec("Sig_B1", on_page=1, box=(60, 150, 300, 240)),
                  text_params=params, timing="b1_sign_visible_textstamp")
        sign_file(src, OUT / "b1_bug_2048upm.pdf", signer,
                  signers.PdfSignatureMetadata(field_name="Sig_B1", **base),
                  stamp_style=style_pyhanko_text(png, fix_upm=False),
                  field_spec=SigFieldSpec("Sig_B1", on_page=1, box=(60, 150, 300, 240)),
                  text_params=params)

        # (b2) visible, reportlab-rendered appearance imported as XObject
        b2 = OUT / "b2_visible_custom_appearance.pdf"
        app = OUT / "_appearance_b2.pdf"
        lines = [
            "Ký bởi: Nguyễn Văn A",
            "Đơn vị: Công ty TNHH Thử Nghiệm",
            "MST: 0101234567",
            params["date_vn"] + now.strftime(" %H:%M:%S"),
            "Lý do: " + params["reason"],
            "Nơi ký: " + params["location"],
        ]
        fs = render_appearance_pdf(app, 240, 90, png, lines)
        RESULTS["notes"].append(f"b2 auto-shrink chose font size {fs}pt for 240x90 box")
        sign_file(src, b2, signer, signers.PdfSignatureMetadata(field_name="Sig_B2", **base),
                  stamp_style=StaticStampStyle.from_pdf_file(str(app), border_width=0),
                  field_spec=SigFieldSpec("Sig_B2", on_page=1, box=(60, 150, 300, 240)),
                  timing="b2_sign_visible_custom")

        # (c) public TSA probe (B-T) + B-T with local TSA
        probe_public_tsas()
        ok = [u for u, r in RESULTS["public_tsa"].items() if r.startswith("OK")]
        with revocation_server.serve():
            local_tsa = timestamps.HTTPTimeStamper(f"{BASE_URL}/tsa")
            if ok:
                sign_file(src, OUT / "c_bt_public_tsa.pdf", signer,
                          signers.PdfSignatureMetadata(field_name="Sig_C", **base),
                          timestamper=timestamps.HTTPTimeStamper(ok[0]), timing="c_sign_bt_public_tsa")
            sign_file(src, OUT / "c_bt_local_tsa.pdf", signer,
                      signers.PdfSignatureMetadata(field_name="Sig_C", **base),
                      timestamper=local_tsa, timing="c_sign_bt_local_tsa")

            # (d) B-LT and B-LTA (revocation info fetched from local OCSP/CRL)
            sign_file(src, OUT / "d_blt.pdf", signer,
                      signers.PdfSignatureMetadata(field_name="Sig_D", embed_validation_info=True,
                                                   validation_context=online_vc(), **base),
                      timestamper=local_tsa, timing="d_sign_blt")
            sign_file(src, OUT / "d_blta.pdf", signer,
                      signers.PdfSignatureMetadata(field_name="Sig_D", embed_validation_info=True,
                                                   use_pades_lta=True, validation_context=online_vc(),
                                                   **base),
                      timestamper=local_tsa, timing="d_sign_blta")

            # (e) two signers; fields pre-created (I30 "empty signature field for others")
            e0 = OUT / "_e0_with_fields.pdf"
            with src.open("rb") as inf:
                w = IncrementalPdfFileWriter(inf, strict=False)
                fields.append_signature_field(w, SigFieldSpec("BenA", on_page=1, box=(60, 150, 260, 240)))
                fields.append_signature_field(w, SigFieldSpec("BenB", on_page=1, box=(340, 150, 540, 240)))
                with e0.open("wb") as outf:
                    w.write(outf)
            e1 = OUT / "e1_first_signature.pdf"
            render_appearance_pdf(app, 200, 90, png, lines)
            sign_file(e0, e1, signer, signers.PdfSignatureMetadata(field_name="BenA", **base),
                      stamp_style=StaticStampStyle.from_pdf_file(str(app), border_width=0),
                      timestamper=local_tsa, timing="e_sign_first")
            signer2 = signers.SimpleSigner.load(
                str(PKI / "signer2.key.pem"), str(PKI / "signer2.crt.pem"),
                ca_chain_files=(str(PKI / "inter.crt.pem"), str(PKI / "root.crt.pem")),
            )
            app2 = OUT / "_appearance_b.pdf"
            render_appearance_pdf(app2, 200, 90, make_signature_png(OUT / "signature2.png", ink=(0, 0, 0)),
                                  ["Ký bởi: Trần Thị B", "Công ty Cổ phần Ví Dụ", params["date_vn"],
                                   "Lý do: Đồng ý"])
            sign_file(e1, OUT / "e2_second_signature.pdf", signer2,
                      signers.PdfSignatureMetadata(field_name="BenB", md_algorithm="sha256",
                                                   subfilter=SigSeedSubFilter.PADES, reason="Đồng ý"),
                      stamp_style=StaticStampStyle.from_pdf_file(str(app2), border_width=0),
                      timestamper=local_tsa, timing="e_sign_second")

            # (f) certification (DocMDP FILL_FORMS) then approval by signer2
            f1 = OUT / "f1_certified.pdf"
            sign_file(e0, f1, signer,
                      signers.PdfSignatureMetadata(field_name="BenA", certify=True,
                                                   docmdp_permissions=MDPPerm.FILL_FORMS, **base),
                      timing="f_sign_certify")
            sign_file(f1, OUT / "f2_certified_plus_approval.pdf", signer2,
                      signers.PdfSignatureMetadata(field_name="BenB", md_algorithm="sha256",
                                                   subfilter=SigSeedSubFilter.PADES),
                      timing="f_sign_approval")
            # NO_CHANGES certification: does pyHanko refuse a later signature?
            f3 = OUT / "f3_certified_nochanges.pdf"
            sign_file(e0, f3, signer,
                      signers.PdfSignatureMetadata(field_name="BenA", certify=True,
                                                   docmdp_permissions=MDPPerm.NO_CHANGES, **base))
            try:
                sign_file(f3, OUT / "_f4_should_fail.pdf", signer2,
                          signers.PdfSignatureMetadata(field_name="BenB", md_algorithm="sha256"))
                RESULTS["notes"].append("NO_CHANGES + later approval: pyHanko did NOT refuse")
            except SigningError as e:
                RESULTS["notes"].append(f"NO_CHANGES + later approval: pyHanko refused ({e})")

            # revoked signer (software key) to check the validator flags it
            rsigner = signers.SimpleSigner.load(
                str(PKI / "revoked.key.pem"), str(PKI / "revoked.crt.pem"),
                ca_chain_files=(str(PKI / "inter.crt.pem"),),
            )
            sign_file(src, OUT / "g_revoked_signer.pdf", rsigner,
                      signers.PdfSignatureMetadata(field_name="Sig_G", md_algorithm="sha256",
                                                   subfilter=SigSeedSubFilter.PADES))
            try:
                sign_file(src, OUT / "_g_revoked_blt.pdf", rsigner,
                          signers.PdfSignatureMetadata(field_name="Sig_G", md_algorithm="sha256",
                                                       subfilter=SigSeedSubFilter.PADES,
                                                       embed_validation_info=True,
                                                       validation_context=online_vc()),
                          timestamper=local_tsa)
                RESULTS["notes"].append("B-LT with revoked cert: pyHanko did NOT refuse")
            except Exception as e:  # noqa: BLE001
                RESULTS["notes"].append(f"B-LT with revoked cert: refused before signing ({type(e).__name__}: {str(e)[:160]})")
            RESULTS["server_hits"] = dict(revocation_server.STATS)

        # (h) raw CKM_RSA_PKCS (hash on host, DigestInfo wrapped by pyHanko): fallback for
        # tokens/drivers that lack CKM_SHA256_RSA_PKCS.
        raw_signer = PKCS11Signer(session, key_id=KEY_ID, cert_id=KEY_ID, other_certs_to_pull=None,
                                  use_raw_mechanism=True)
        sign_file(src, OUT / "h_raw_rsa_pkcs.pdf", raw_signer,
                  signers.PdfSignatureMetadata(field_name="Sig_H", **base), timing="h_sign_raw_mechanism")

        # batch: 10 invisible signatures with one login (I31)
        batch_dir = OUT / "_batch"
        batch_dir.mkdir(exist_ok=True)
        t = time.perf_counter()
        for i in range(10):
            sign_file(src, batch_dir / f"doc{i:02d}.pdf", signer,
                      signers.PdfSignatureMetadata(field_name="Sig", **base))
        RESULTS["timings_ms"]["batch_10_invisible_total"] = round((time.perf_counter() - t) * 1000, 1)
    finally:
        session.close()

    # Render the visible appearances for visual inspection.
    for n in ("b1_visible_pyhanko_style", "b1_bug_2048upm", "b2_visible_custom_appearance"):
        render_page(OUT / f"{n}.pdf", 1, OUT / f"{n}.png", scale=3, crop_pt=(50, 140, 310, 250))
    render_page(OUT / "e2_second_signature.pdf", 1, OUT / "e2_second_signature.png", scale=2,
                crop_pt=(40, 130, 560, 280))

    (OUT / "results.json").write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
    print(json.dumps(RESULTS, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
