// Sinh theme Rust cho bản native từ apps/ui/src/app/styles/tokens.css (TASKS_RUST R1.11).
// Chạy: node scripts/gen-native-theme.mjs          (ghi file)
//       node scripts/gen-native-theme.mjs --check  (thoát lỗi nếu file đã commit bị lệch)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE = resolve(here, '../apps/ui/src/app/styles/tokens.css');
export const OUTPUT = resolve(here, '../apps/native/crates/chef-theme/src/generated.rs');

// Khối khai báo: `:root { ... }` và `:root[data-theme='dark'] { ... }`.
export function parseBlocks(css) {
  const strip = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const root = strip.match(/:root\s*\{([\s\S]*?)\n\}/);
  const dark = strip.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);
  if (!root || !dark) throw new Error('không tìm thấy khối :root hoặc :root[data-theme=dark] trong tokens.css');
  return { root: declarations(root[1]), dark: declarations(dark[1]) };
}

// Mỗi dòng `--ten: giá trị;` thành [ten, giá trị]. Bỏ khai báo không phải token (color-scheme).
export function declarations(body) {
  const out = [];
  for (const m of body.matchAll(/--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.push([m[1], m[2].trim()]);
  }
  return out;
}

// Đổi var(--x) bằng giá trị của --x trong cùng khối (đệ quy, có chặn vòng lặp).
export function resolveVars(value, env, depth = 0) {
  if (depth > 8) throw new Error(`var() lồng quá sâu: ${value}`);
  return value.replace(/var\(--([a-zA-Z0-9-]+)\)/g, (_, name) => {
    if (!(name in env)) throw new Error(`var(--${name}) không có trong khối`);
    return resolveVars(env[name], env, depth + 1);
  });
}

// Chuyển màu CSS sang [r, g, b, a] (0–255). Hỗ trợ #rgb, #rrggbb, rgb(), rgba().
export function parseColor(value) {
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
  }
  const fn = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (fn) {
    const a = fn[4] === undefined ? 1 : Number(fn[4]);
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), Math.round(a * 255)];
  }
  return null;
}

// Phân loại: màu, bóng và viền focus thuộc theme (sáng/tối); còn lại là dùng chung.
export function isThemeToken(name) {
  return name.startsWith('c-') || name.startsWith('shadow-') || name === 'focus-ring';
}

export function constName(name) {
  return name.replace(/-/g, '_').toUpperCase();
}

// Literal f32 của Rust cần dấu thập phân: `11` không hợp lệ, phải là `11.0`.
export function floatLit(text) {
  const n = String(Number(text));
  return n.includes('.') || n.includes('e') ? n : `${n}.0`;
}

// Giá trị px -> f32; số thuần -> f32; ms -> u32; chuỗi còn lại -> &str.
export function sharedRust(name, value) {
  const px = value.match(/^(-?[\d.]+)px$/);
  if (px) return { type: 'f32', lit: floatLit(px[1]) };
  const ms = value.match(/^(\d+)ms$/);
  if (ms) return { type: 'u32', lit: ms[1] };
  if (/^-?[\d.]+$/.test(value)) return { type: 'f32', lit: floatLit(value) };
  return { type: '&str', lit: JSON.stringify(value.replace(/'/g, '"')) };
}

function themeRust(name, value) {
  const color = parseColor(value);
  if (color) return { type: 'Rgba', lit: `[${color.join(', ')}]` };
  return { type: '&str', lit: JSON.stringify(value) };
}

// Sinh toàn bộ file. Trả về { text, counts } để kiểm tra số khai báo.
export function generate(css) {
  const { root, dark } = parseBlocks(css);
  const rootEnv = Object.fromEntries(root);
  const darkEnv = { ...rootEnv, ...Object.fromEntries(dark) };

  const shared = root.filter(([n]) => !isThemeToken(n));
  const lightTokens = root.filter(([n]) => isThemeToken(n));
  const darkOverrides = dark.filter(([n]) => isThemeToken(n));
  const darkNames = new Set(darkOverrides.map(([n]) => n));
  if (dark.some(([n]) => !isThemeToken(n))) {
    throw new Error('khối dark chỉ được khai báo màu và bóng, token dùng chung đặt ở :root');
  }

  const lines = [];
  lines.push('// @generated bởi scripts/gen-native-theme.mjs từ apps/ui/src/app/styles/tokens.css.');
  lines.push('// Không sửa tay. Sửa tokens.css rồi chạy: node scripts/gen-native-theme.mjs');
  lines.push('#![allow(dead_code)]');
  lines.push('');
  lines.push('/// Màu RGBA, mỗi kênh 0–255.');
  lines.push('pub type Rgba = [u8; 4];');
  lines.push('');
  lines.push('/// Token dùng chung cho mọi theme: font, cỡ chữ, khoảng cách, bo góc, kích thước, chuyển động.');
  lines.push('pub mod shared {');
  for (const [n, v] of shared) {
    const r = sharedRust(n, resolveVars(v, rootEnv));
    lines.push(`    pub const ${constName(n)}: ${r.type} = ${r.lit};`);
  }
  lines.push('}');
  lines.push('');
  for (const [mod, env, names] of [
    ['light', rootEnv, lightTokens.map(([n]) => n)],
    ['dark', darkEnv, lightTokens.map(([n]) => n)],
  ]) {
    lines.push(
      mod === 'light'
        ? '/// Màu và bóng theme sáng (`:root`).'
        : '/// Màu và bóng theme tối (`:root[data-theme=\'dark\']`, các token không ghi đè lấy từ sáng).',
    );
    lines.push(`pub mod ${mod} {`);
    lines.push('    use super::Rgba;');
    for (const n of names) {
      const r = themeRust(n, resolveVars(env[n], env));
      lines.push(`    pub const ${constName(n)}: ${r.type} = ${r.lit};`);
    }
    lines.push('}');
    lines.push('');
  }
  // Đếm để kiểm tra: khai báo ở :root, khai báo ở dark, và tổng.
  const counts = {
    root: root.length,
    dark: dark.length,
    total: root.length + dark.length,
    sharedCount: shared.length,
    themeLight: lightTokens.length,
    darkOverrides: darkOverrides.length,
    darkNames: darkNames.size,
  };
  return { text: lines.join('\n') + '\n', counts };
}

export function main(argv = process.argv.slice(2)) {
  const css = readFileSync(SOURCE, 'utf8');
  const { text, counts } = generate(css);
  if (argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
      current = '';
    }
    if (current !== text) {
      console.error(`generated.rs lệch khỏi tokens.css. Chạy: node scripts/gen-native-theme.mjs`);
      process.exitCode = 1;
      return counts;
    }
    console.log(`generated.rs khớp tokens.css (${counts.total} khai báo)`);
    return counts;
  }
  writeFileSync(OUTPUT, text);
  console.log(`đã ghi ${OUTPUT} (${counts.total} khai báo: ${counts.root} ở :root, ${counts.dark} ở dark)`);
  return counts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
