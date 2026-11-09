// Sinh bộ đối chiếu i18n cho bản Rust (TASKS_RUST R2.13): kết quả của chính i18next của dự án
// (apps/ui/node_modules/i18next) với cùng cấu hình như apps/ui/src/i18n/index.ts.
//
// Ghi apps/native/crates/chef-ui/tests/i18n_golden.json. Chạy lại khi đổi vi.json hoặc en.json:
//   node scripts/gen-native-i18n-golden.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/ui/package.json'));
const i18next = require('i18next');

const assets = path.join(root, 'apps/native/assets/i18n');
const vi = JSON.parse(fs.readFileSync(path.join(assets, 'vi.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(assets, 'en.json'), 'utf8'));

const PLURAL = /_(zero|one|two|few|many|other)$/;

function leaves(tree, prefix = '') {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [[prefix + k, v]] : leaves(v, `${prefix}${k}.`),
  );
}

// Khóa gốc (bỏ hậu tố số nhiều) và các tham số {{…}} xuất hiện trong chuỗi của nó.
const baseKeys = new Map();
for (const [src] of [...leaves(vi), ...leaves(en)]) {
  const base = src.replace(PLURAL, '');
  if (!baseKeys.has(base)) baseKeys.set(base, new Set());
}
for (const [src, text] of [...leaves(vi), ...leaves(en)]) {
  const base = src.replace(PLURAL, '');
  for (const m of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) baseKeys.get(base).add(m[1]);
}

// 5 không thêm gì: en chỉ có one (|n| = 1) và other, vi chỉ có other.
const COUNTS = [undefined, 0, 1, 2];
const cases = [];

for (const lng of ['vi', 'en']) {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: { vi: { translation: vi }, en: { translation: en } },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
  for (const [key, names] of baseKeys) {
    for (const count of COUNTS) {
      // Đủ tham số cho mọi biến; biến "count" lấy số đếm.
      const opts = {};
      for (const n of names) opts[n] = `<${n}>`;
      if (count !== undefined) opts.count = count;
      cases.push({ lng, key, options: opts, out: i18n.t(key, opts) });
    }
    // Thiếu tham số: i18next giữ nguyên hay thay trống, cần biết để khớp.
    if (names.size > 0) {
      cases.push({ lng, key, options: {}, out: i18n.t(key, {}) });
    }
  }
}

const outFile = path.join(root, 'apps/native/crates/chef-ui/tests/i18n_golden.json');
fs.writeFileSync(outFile, JSON.stringify({ i18next: require('i18next/package.json').version, cases }) + '\n');
console.log(`ghi ${cases.length} trường hợp vào ${path.relative(root, outFile)}`);
