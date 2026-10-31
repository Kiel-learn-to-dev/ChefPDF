/* global console */
// Generates dev/sample.pdf: a multi-page Vietnamese document with an outline,
// used by the mock bridge (?demo) and UI screenshots. Not shipped.
// Run: NODE_PATH=$(npm root -g) node scripts/make-sample-pdf.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'dev', 'sample.pdf');

const chapters = [
  [
    'Chương I. Quy định chung',
    'Nghị định này quy định về giao dịch điện tử, chữ ký số và dịch vụ chứng thực chữ ký số. Đối tượng áp dụng gồm cơ quan, tổ chức, cá nhân tham gia giao dịch điện tử tại Việt Nam.',
  ],
  [
    'Chương II. Chữ ký số',
    'Chữ ký số được tạo ra bằng khóa bí mật tương ứng với chứng thư số do tổ chức cung cấp dịch vụ chứng thực chữ ký số cấp. Việc ký số trên văn bản điện tử có giá trị pháp lý như chữ ký tay.',
  ],
  [
    'Chương III. Đóng dấu và lưu trữ',
    'Văn bản điện tử sau khi ký số được lưu trữ an toàn, bảo đảm tính toàn vẹn. Đường dẫn, tên file và mục lục cần đặt rõ ràng để dễ tra cứu.',
  ],
  [
    'Chương IV. Điều khoản thi hành',
    'Nghị định này có hiệu lực kể từ ngày ký. Các bộ, cơ quan ngang bộ, Ủy ban nhân dân các tỉnh, thành phố trực thuộc trung ương chịu trách nhiệm thi hành nghị định này.',
  ],
];

const para = (t, i) =>
  `<p>Điều ${i}. ${t} Đây là đoạn văn mẫu tiếng Việt có dấu đầy đủ: ă â đ ê ô ơ ư, ĐƯỜNG ĐI, Đà Nẵng, Huế, Hà Nội.</p>`;

const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: 'DejaVu Serif', 'Noto Serif', Georgia, serif; font-size: 12pt; line-height: 1.55; color: #1b1b1b; }
  h1 { font-size: 22pt; text-align: center; margin: 40mm 0 6mm; }
  .sub { text-align: center; color: #555; margin-bottom: 30mm; }
  h2 { font-size: 15pt; margin-top: 0; break-before: page; color: #8a1f11; }
  p { text-align: justify; margin: 0 0 4mm; }
  .box { border: 1px solid #bbb; padding: 4mm 6mm; margin: 6mm 0; background: #f6f6f2; }
  table { width: 100%; border-collapse: collapse; margin: 6mm 0; }
  td, th { border: 1px solid #999; padding: 2mm 3mm; font-size: 11pt; }
</style></head><body>
<h1>NGHỊ ĐỊNH MẪU<br/>về giao dịch điện tử</h1>
<div class="sub">Tài liệu mẫu cho Chef PDF · Không có giá trị pháp lý</div>
<div class="box">Tài liệu này dùng để thử tìm kiếm không dấu: gõ “nghi dinh” sẽ ra “nghị định”, gõ “dong dau” sẽ ra “đóng dấu”.</div>
${chapters
  .map(
    ([title, body], c) => `<h2>${title}</h2>
${Array.from({ length: 9 }, (_, i) => para(body, c * 9 + i + 1)).join('\n')}
<table><tr><th>Mục</th><th>Nội dung</th><th>Ghi chú</th></tr>
<tr><td>1</td><td>Chữ ký số của cơ quan</td><td>Bắt buộc</td></tr>
<tr><td>2</td><td>Đóng dấu giáp lai</td><td>Khi có nhiều trang</td></tr></table>
${Array.from({ length: 6 }, (_, i) => para(body, c * 9 + i + 10)).join('\n')}`,
  )
  .join('\n')}
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
mkdirSync(dirname(out), { recursive: true });
await page.pdf({
  path: out,
  format: 'A4',
  printBackground: true,
  outline: true,
  tagged: true,
  preferCSSPageSize: true,
});
await browser.close();
console.log('wrote', out);
