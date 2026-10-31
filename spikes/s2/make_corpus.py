"""Generate the S2 test corpus with reportlab.

corpus.pdf, 3 A4 pages, each with:
  * the same logo image XObject in the header (reused across pages)
  * a Vietnamese header block (reportlab: subset-embedded *simple* TrueType fonts)
  * one address line in a subset *Type0/Identity-H CID* font inside a Form XObject
    (stamped with pyHanko), the way Word/LibreOffice embed Vietnamese fonts
  * a "personal data" line (CCCD / phone) next to a photo image (redaction target)
  * vector shapes (frame, circle, separator)
  * a two-column Vietnamese body (platypus frames)
  * an untagged watermark "BẢN NHÁP", rotated 45 deg, fill alpha 0.25, on top
  * a *tagged* watermark "MẬT" inside /Artifact <</Subtype /Watermark>> BDC ... EMC

corpus_truth.json keeps the ground-truth paragraphs (for S2-5) and target strings.
"""

from __future__ import annotations

import json

import pikepdf
from PIL import Image, ImageDraw
from pyhanko.pdf_utils.font.opentype import GlyphAccumulatorFactory
from pyhanko.pdf_utils.text import TextBoxStyle
from pyhanko.stamp import TextStampStyle, text_stamp_file
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph

from common.fonts import bold_font, font_1000_upm, regular_font

from .common import CORPUS, OUT, TRUTH

W, H = A4
EDIT_LINE = "Đơn vị: Công ty TNHH Thử Nghiệm Hà Nội"
PII_LINE = "Họ tên: Nguyễn Văn A, CCCD: 001234567890, SĐT: 0912 345 678"
WATERMARK = "BẢN NHÁP"
TAGGED_WM = "MẬT"
CID_LINE = "Địa chỉ: Số 1 Tràng Tiền, Hoàn Kiếm, Hà Nội"

PARAGRAPHS = [
    "Điều 1. Phạm vi điều chỉnh. Văn bản này quy định về việc tiếp nhận, xử lý và lưu trữ "
    "hồ sơ điện tử của tổ chức, cá nhân khi thực hiện thủ tục hành chính trên môi trường mạng.",
    "Điều 2. Đối tượng áp dụng. Quy định này áp dụng đối với cơ quan nhà nước, tổ chức chính trị "
    "xã hội và các cá nhân có liên quan đến việc sử dụng chữ ký số trong giao dịch điện tử.",
    "Điều 3. Giải thích từ ngữ. Trong văn bản này, các từ ngữ dưới đây được hiểu như sau: hồ sơ "
    "điện tử là tập hợp các tài liệu dưới dạng thông điệp dữ liệu có liên quan với nhau.",
    "Điều 4. Nguyên tắc chung. Việc tiếp nhận hồ sơ phải bảo đảm công khai, minh bạch, đúng thời "
    "hạn và không làm phát sinh chi phí ngoài quy định cho người nộp hồ sơ.",
    "Điều 5. Trách nhiệm thi hành. Thủ trưởng các cơ quan, đơn vị và cá nhân có liên quan chịu "
    "trách nhiệm thi hành quyết định này kể từ ngày ký ban hành.",
    "Điều 6. Hiệu lực. Quyết định có hiệu lực kể từ ngày ký. Các quy định trước đây trái với "
    "quyết định này đều bị bãi bỏ. Văn phòng chủ trì theo dõi, đôn đốc việc thực hiện.",
]


def make_images():
    logo = OUT / "logo.png"
    im = Image.new("RGB", (200, 200), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.ellipse((10, 10, 190, 190), fill=(200, 30, 30))
    d.rectangle((70, 60, 130, 140), fill=(255, 220, 0))
    im.save(logo)
    photo = OUT / "photo.png"
    ph = Image.new("RGB", (240, 300))
    px = ph.load()
    for y in range(300):
        for x in range(240):
            px[x, y] = (int(255 * x / 240), int(255 * y / 300), 160)
    ImageDraw.Draw(ph).text((20, 140), "ANH THE", fill=(0, 0, 0))
    ph.save(photo)
    return logo, photo


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pdfmetrics.registerFont(TTFont("VN", str(regular_font())))
    pdfmetrics.registerFont(TTFont("VNB", str(bold_font())))
    logo, photo = make_images()

    def on_page(c, doc):
        c.saveState()
        c.drawImage(str(logo), 40, H - 95, 55, 55)  # same XObject on every page
        c.setFont("VNB", 14)
        c.drawString(105, H - 60, "CÔNG TY TNHH THỬ NGHIỆM")
        c.setFont("VN", 11)
        c.drawString(105, H - 78, EDIT_LINE)
        c.drawString(40, H - 125, PII_LINE)
        if doc.page == 1:
            c.drawImage(str(photo), 470, H - 152, 55, 66)
        # vector shapes
        c.setStrokeColorRGB(0.1, 0.3, 0.6)
        c.setLineWidth(1.5)
        c.rect(30, 30, W - 60, H - 60)
        c.line(40, H - 140, W - 140, H - 140)
        c.setFillColorRGB(0.2, 0.6, 0.3)
        c.circle(W - 80, H - 60, 18, fill=1, stroke=0)
        c.setFont("VN", 9)
        c.setFillColorRGB(0, 0, 0)
        c.drawCentredString(W / 2, 40, f"Trang {doc.page}")
        c.restoreState()

    def on_page_end(c, doc):
        # untagged watermark: rotated, translucent, drawn over the content
        c.saveState()
        c.setFillColor(Color(0.85, 0.1, 0.1, alpha=0.25))
        c.setFont("VNB", 72)
        c.translate(W / 2, H / 2)
        c.rotate(45)
        c.drawCentredString(0, 0, WATERMARK)
        c.restoreState()
        # tagged watermark (what Chef PDF itself will write, D14)
        c.saveState()
        c._code.append("/Artifact <</Type /Pagination /Subtype /Watermark>> BDC")
        c.setFillColor(Color(0.2, 0.2, 0.8, alpha=0.3))
        c.setFont("VNB", 28)
        c.drawString(W - 130, 60, TAGGED_WM)
        c._code.append("EMC")
        c.restoreState()

    doc = BaseDocTemplate(str(CORPUS), pagesize=A4, title="Chef PDF S2 corpus",
                          leftMargin=40, rightMargin=40, topMargin=160, bottomMargin=60)
    gap = 24
    col_w = (W - 80 - gap) / 2
    frames = [Frame(40, 60, col_w, H - 220, id="left", showBoundary=0),
              Frame(40 + col_w + gap, 60, col_w, H - 220, id="right", showBoundary=0)]
    doc.addPageTemplates([PageTemplate(id="two", frames=frames, onPage=on_page, onPageEnd=on_page_end)])
    style = ParagraphStyle("body", fontName="VN", fontSize=10.5, leading=14, spaceAfter=9,
                           firstLineIndent=14, alignment=4)  # justified
    story, truth_pars = [], []
    for page in range(3):
        for i, p in enumerate(PARAGRAPHS):
            txt = p if page == 0 else p.replace("Điều", f"Mục {page}.", 1)
            # repeat to fill the columns
            story.append(Paragraph(txt, style))
            truth_pars.append(txt)
            story.append(Paragraph(txt.split(".")[0] + " (tiếp). " + PARAGRAPHS[(i + 1) % 6], style))
            truth_pars.append(txt.split(".")[0] + " (tiếp). " + PARAGRAPHS[(i + 1) % 6])
    doc.build(story)
    # Add the CID-font line on every page, then flatten revisions with qpdf.
    style_cid = TextStampStyle(stamp_text="%(t)s", border_width=0, text_box_style=TextBoxStyle(
        font=GlyphAccumulatorFactory(str(font_1000_upm(regular_font(), OUT)), font_size=10)))
    tmp_in, tmp_out = OUT / "_corpus_rl.pdf", OUT / "_corpus_stamped.pdf"
    CORPUS.replace(tmp_in)
    for i in range(3):
        text_stamp_file(str(tmp_in), str(tmp_out), style_cid, i, 100, int(H - 116), {"t": CID_LINE})
        tmp_out.replace(tmp_in)
    with pikepdf.open(tmp_in) as p:
        p.save(CORPUS)
    tmp_in.unlink()
    all_text = CID_LINE + EDIT_LINE + PII_LINE + "".join(truth_pars) + "CÔNG TY TNHH THỬ NGHIỆM" + WATERMARK + TAGGED_WM
    TRUTH.write_text(json.dumps({
        "paragraphs": truth_pars, "edit_line": EDIT_LINE, "pii_line": PII_LINE,
        "watermark": WATERMARK, "tagged_watermark": TAGGED_WM, "cid_line": CID_LINE,
        "chars_in_corpus": "".join(sorted(set(all_text))),
    }, ensure_ascii=False, indent=2))
    print(f"wrote {CORPUS} and {TRUTH}")


if __name__ == "__main__":
    main()
