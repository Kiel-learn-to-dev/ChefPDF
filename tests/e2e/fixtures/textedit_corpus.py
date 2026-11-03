"""Generates contract.pdf for textedit.spec.ts and annots.spec.ts (run with the core environment).

Usage: python textedit_corpus.py OUT_DIR

contract.pdf: three A4-like pages (612 x 792 pt) of Vietnamese text drawn with Be Vietnam Pro.
ReportLab embeds a SUBSET of the font: only the characters used in the file. The replacement
sentences of the tests use characters that are not in that subset (ư, ữ, ệ), so an edit must
replace the font (text.checkText reports it) to write them.

Page 1: the heading, the company line "Bên A là Công ty ABC..." (y 710), the line
        "Thanh toán trong vòng 30 ngày." (y 640) and a second company line.
Pages 2-3: the company name 'Công ty ABC' in two lines each (find and replace across pages).
"""

import sys
from pathlib import Path

import chef_core
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT_DIR = Path(chef_core.__file__).parent / "resources" / "fonts"
pdfmetrics.registerFont(TTFont("TxtBeVN", str(FONT_DIR / "BeVietnamPro-Regular.ttf")))
pdfmetrics.registerFont(TTFont("TxtBeVNBold", str(FONT_DIR / "BeVietnamPro-Bold.ttf")))

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)


def put(cv: canvas.Canvas, x: float, y: float, text: str, size: float = 11, bold: bool = False) -> None:
    cv.setFont("TxtBeVNBold" if bold else "TxtBeVN", size)
    cv.drawString(x, y, text)


cv = canvas.Canvas(str(out / "contract.pdf"), pagesize=(612, 792))
for index in range(3):
    put(cv, 72, 740, f"Hợp đồng số {index + 1}", 14, bold=True)
    if index == 0:
        put(cv, 72, 710, "Bên A là Công ty ABC, đại diện bởi giám đốc.", 11)
        put(cv, 72, 640, "Thanh toán trong vòng 30 ngày.", 11)
        put(cv, 72, 610, "Mọi khoản phí do bên B chịu.", 11)
    else:
        put(cv, 72, 710, "Bên B cam kết hợp tác cùng Công ty ABC trong dự án.", 11)
        put(cv, 72, 690, "Mọi tranh chấp giữa Công ty ABC và bên B sẽ được giải quyết.", 11)
    cv.showPage()
cv.save()
print(str(out / "contract.pdf"))
