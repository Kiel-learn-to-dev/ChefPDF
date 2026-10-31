"""Sample inputs for S1: a Vietnamese contract PDF and a transparent signature PNG."""

from __future__ import annotations

import math

from PIL import Image, ImageDraw, ImageFilter
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from common.fonts import bold_font, regular_font

from .common import OUT


def make_contract_pdf(path=None):
    path = path or OUT / "input_contract.pdf"
    pdfmetrics.registerFont(TTFont("VN", str(regular_font())))
    pdfmetrics.registerFont(TTFont("VNB", str(bold_font())))
    c = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    for page in (1, 2):
        c.setFont("VNB", 13)
        c.drawCentredString(w / 2, h - 60, "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM")
        c.setFont("VNB", 12)
        c.drawCentredString(w / 2, h - 78, "Độc lập - Tự do - Hạnh phúc")
        c.setFont("VNB", 15)
        c.drawCentredString(w / 2, h - 120, f"HỢP ĐỒNG DỊCH VỤ (trang {page}/2)")
        c.setFont("VN", 11)
        y = h - 160
        for line in [
            "Căn cứ Bộ luật Dân sự số 91/2015/QH13 ngày 24 tháng 11 năm 2015;",
            "Căn cứ Luật Giao dịch điện tử số 20/2023/QH15;",
            "Hôm nay, tại Hà Nội, chúng tôi gồm có:",
            "Bên A: Công ty TNHH Thử Nghiệm, MST 0101234567, đại diện ông Nguyễn Văn A.",
            "Bên B: Công ty Cổ phần Ví Dụ, đại diện bà Trần Thị B.",
            "Hai bên thống nhất ký kết hợp đồng với các điều khoản sau đây...",
        ]:
            c.drawString(60, y, line)
            y -= 18
        if page == 2:
            c.setFont("VNB", 11)
            c.drawString(80, 260, "ĐẠI DIỆN BÊN A")
            c.drawString(360, 260, "ĐẠI DIỆN BÊN B")
            c.setFont("VN", 9)
            c.drawString(80, 246, "(Ký, ghi rõ họ tên)")
            c.drawString(360, 246, "(Ký, ghi rõ họ tên)")
        c.showPage()
    c.save()
    return path


def make_signature_png(path=None, ink=(20, 40, 160)):
    """Handwriting-like blue scribble on a fully transparent background."""
    path = path or OUT / "signature.png"
    W, H = 600, 240
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = []
    for i in range(400):
        t = i / 399
        x = 40 + 520 * t
        y = 120 + 60 * math.sin(t * 9) * math.exp(-t) + 25 * math.sin(t * 31)
        pts.append((x, y))
    d.line(pts, fill=(*ink, 255), width=7, joint="curve")
    d.line([(60, 190), (540, 170)], fill=(*ink, 255), width=5)
    img = img.filter(ImageFilter.SMOOTH)
    img.save(path)
    return path


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    print(make_contract_pdf(), make_signature_png())
