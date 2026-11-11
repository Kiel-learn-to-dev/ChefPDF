"""Sinh PDF có mật khẩu cho E2E (TASKS_RUST R2.26): mật khẩu người dùng "thu123", mật khẩu chủ sở hữu
khác. Chạy: uv run --no-project python scripts/gen-native-password-fixture.py <đường dẫn ra>."""
import sys, pikepdf
out = sys.argv[1]
pdf = pikepdf.new()
pdf.add_blank_page(page_size=(595.276, 841.89))
pdf.docinfo['/Title'] = 'Tài liệu khóa'
pdf.save(out, encryption=pikepdf.Encryption(user='thu123', owner='chu-so-huu', R=6), min_version='1.7')
print('saved', out)
