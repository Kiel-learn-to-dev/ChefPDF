"""Generates the contract of demo-v07.spec.ts (run with the core environment: uv run).

Usage: python demo_v07_corpus.py OUT_DIR
  hop_dong.pdf : four A4 pages of Vietnamese contract text drawn with Be Vietnam Pro. ReportLab
                 embeds a SUBSET of the font (only the characters used). The company name
                 'Công ty ABC' is on every page, six times in all. Page 1 has the sentence the
                 demo edits: "Thanh toán trong vòng 30 ngày" (ư and ớ are not in the subset).
  khac.pdf     : a second, unrelated PDF next to it. The demo never opens it in the app; it must
                 stay byte-identical and still open.
"""

import sys
from pathlib import Path

import chef_core
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT_DIR = Path(chef_core.__file__).parent / "resources" / "fonts"
pdfmetrics.registerFont(TTFont("DemoVN", str(FONT_DIR / "BeVietnamPro-Regular.ttf")))
pdfmetrics.registerFont(TTFont("DemoVNBold", str(FONT_DIR / "BeVietnamPro-Bold.ttf")))

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

PAGES = [
    [
        ("Hợp đồng dịch vụ số 07/2026", 14, True, 740),
        ("Bên A là Công ty ABC, đại diện bởi giám đốc Nguyễn Văn An.", 11, False, 710),
        ("Thanh toán trong vòng 30 ngày kể từ ngày nghiệm thu.", 11, False, 640),
        ("Mọi khoản phí do bên B chịu.", 11, False, 610),
    ],
    [
        ("Điều 2. Bên B cam kết hợp tác cùng Công ty ABC trong dự án.", 11, False, 710),
        ("Công ty ABC chịu trách nhiệm về chất lượng nghiệm thu.", 11, False, 690),
    ],
    [
        (
            "Điều 3. Mọi tranh chấp giữa Công ty ABC và bên B sẽ được giải quyết.",
            11,
            False,
            710,
        ),
        ("Bảo mật thông tin theo quy định của Công ty ABC.", 11, False, 690),
    ],
    [
        ("Điều 4. Hợp đồng có hiệu lực kể từ ngày ký.", 11, False, 710),
        ("Đại diện Công ty ABC", 11, False, 620),
    ],
]

cv = canvas.Canvas(str(out / "hop_dong.pdf"), pagesize=(612, 792))
for lines in PAGES:
    for text, size, bold, y in lines:
        cv.setFont("DemoVNBold" if bold else "DemoVN", size)
        cv.drawString(72, y, text)
    cv.showPage()
cv.save()

other = canvas.Canvas(str(out / "khac.pdf"), pagesize=(612, 792))
other.setFont("DemoVN", 12)
other.drawString(72, 700, "Tài liệu khác: nội dung này không được sửa.")
other.showPage()
other.save()
print(str(out / "hop_dong.pdf"))
