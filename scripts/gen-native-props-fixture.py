"""Sinh PDF mẫu cho E2E thuộc tính tài liệu (TASKS_RUST R2.27): 2 trang (A4 và Letter), phiên bản 1.7,
đủ metadata. Chạy: uv run --no-project python scripts/gen-native-props-fixture.py <đường dẫn ra>."""
import sys, pikepdf
out = sys.argv[1]
pdf = pikepdf.new()
pdf.add_blank_page(page_size=(595.276, 841.89))   # A4
pdf.add_blank_page(page_size=(612, 792))
with pdf.open_metadata() as meta:
    meta['dc:title'] = 'Báo cáo thử'
    meta['dc:creator'] = ['Nguyễn Thử']
    meta['pdf:Producer'] = 'Chef Test'
pdf.docinfo['/Title'] = 'Báo cáo thử'
pdf.docinfo['/Author'] = 'Nguyễn Thử'
pdf.docinfo['/Subject'] = 'Kiểm thử thuộc tính'
pdf.docinfo['/Keywords'] = 'pdf, thử'
pdf.docinfo['/Creator'] = 'mkmeta'
pdf.docinfo['/Producer'] = 'Chef Test'
pdf.docinfo['/CreationDate'] = 'D:20260102030405+07\'00\''
pdf.docinfo['/ModDate'] = 'D:20260315101112Z'
pdf.save(out, min_version='1.7')
print("saved", out)
