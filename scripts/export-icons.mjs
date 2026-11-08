// Xuất icon Lucide dùng trong apps/ui ra SVG cho bản native (TASKS_RUST R1.14).
// Chạy: node scripts/export-icons.mjs
// Thoát lỗi nếu có icon được import nhưng không tìm thấy trong gói lucide-react.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const UI_SRC = resolve(here, '../apps/ui/src');
export const ICON_DIR = resolve(here, '../apps/ui/node_modules/lucide-react/dist/esm/icons');
export const OUT_DIR = resolve(here, '../apps/native/assets/icons');

// Import từ 'lucide-react', kể cả nhiều dòng, `import type`, và alias `X as Y` (lấy tên gốc).
export function lucideImports(source) {
  const names = [];
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g;
  for (const m of source.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || part.startsWith('type ')) continue;
      names.push(part.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

// Tên export (PascalCase) sang tên file (kebab-case): CircleAlert -> circle-alert, Columns2 -> columns-2.
export function toKebab(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .toLowerCase();
}

// Đọc object `__iconData` từ file .mjs của lucide-react (nguồn tin cậy: gói đã cài).
// Tên alias (ví dụ alert-triangle.mjs) chỉ là `export { default } from './triangle-alert.mjs'`, nên đi theo.
export function readIconData(text, dir) {
  const alias = text.match(/export \{ default \} from '\.\/([^']+)';/);
  if (alias) {
    const target = join(dir, alias[1]);
    return readIconData(readFileSync(target, 'utf8'), dir);
  }
  const m = text.match(/const __iconData = ([\s\S]*?);\s*\n__iconData\.node;/);
  if (!m) throw new Error('không đọc được __iconData');
  return Function(`return ${m[1]}`)();
}

const ATTR_ORDER = ['d', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points', 'transform'];

// Node [tag, attrs] -> chuỗi SVG. Nét dùng currentColor để đổi màu theo theme (BLUEPRINT_RUST §6.3).
export function iconToSvg(data) {
  const children = data.node
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .filter(([k]) => k !== 'key')
        .sort(([a], [b]) => {
          const ia = ATTR_ORDER.indexOf(a);
          const ib = ATTR_ORDER.indexOf(b);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
        })
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`);
      return `<${tag} ${pairs.join(' ')}/>`;
    })
    .join('');
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    children +
    '</svg>\n'
  );
}

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(p, out);
    } else if (['.ts', '.tsx'].includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

export function collectNames(srcDir) {
  const names = new Set();
  for (const file of walk(srcDir)) {
    for (const n of lucideImports(readFileSync(file, 'utf8'))) names.add(n);
  }
  return [...names].sort();
}

export function main() {
  if (!existsSync(ICON_DIR)) {
    console.error(`không có gói lucide-react. Chạy pnpm install trước (${ICON_DIR})`);
    process.exitCode = 1;
    return;
  }
  const names = collectNames(UI_SRC);
  mkdirSync(OUT_DIR, { recursive: true });
  const missing = [];
  let written = 0;
  for (const name of names) {
    const file = join(ICON_DIR, `${toKebab(name)}.mjs`);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    const data = readIconData(readFileSync(file, 'utf8'), ICON_DIR);
    writeFileSync(join(OUT_DIR, `${toKebab(name)}.svg`), iconToSvg(data));
    written++;
  }
  console.log(`đã xuất ${written}/${names.length} icon vào ${OUT_DIR}`);
  if (missing.length) {
    console.error(`thiếu ${missing.length} icon: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
  return { names, written, missing };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
