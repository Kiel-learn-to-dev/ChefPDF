#!/usr/bin/env node
/**
 * Báo cáo tĩnh về CSS của giao diện. Chỉ đọc, không sửa file.
 *
 *   node scripts/css-audit.mjs [đường dẫn file hoặc thư mục ...] [--json]
 *
 * Mặc định quét apps/ui/src. Tên biến cục bộ và tên '--x' trong TSX lấy từ toàn bộ apps/ui/src
 * (dù chỉ quét một file), để biến khai báo ở file khác không bị báo nhầm.
 * Luôn thoát với mã 0: đây là báo cáo, không phải cổng kiểm tra.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Thang khoảng cách (kế hoạch UI_AUDIT mục 3, khớp luật gap-off-scale). */
export const SPACE_SCALE = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56];
export const RADIUS_SCALE = [0, 3, 5, 7, 10, 14];
export const FONT_SCALE = [11, 12, 13, 15, 18, 24, 30];
export const CONTROL_HEIGHTS = [26, 32, 38];
/** Chiều cao trong khoảng này được coi là điều khiển; ngoài khoảng là bố cục tự do, không báo. */
const CONTROL_HEIGHT_RANGE = [12, 48];

const SPACE_PROP = /^(gap|row-gap|column-gap|padding|margin)(-[a-z-]+)?$/;
const RADIUS_PROP = /^border(-[a-z]+)*-radius$/;
const HEIGHT_PROP = /^(height|min-height)$/;
const FONT_PROP = /^font-size$/;

/** Bỏ comment, giữ nguyên số dòng. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function makeLineFinder(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const DECL = /^(-{0,2}[a-zA-Z][\w-]*)\s*:\s*([\s\S]*?)\s*$/;

/**
 * Tách khai báo `prop: value` kèm dòng, selector và việc có nằm trong @keyframes không.
 * Cú pháp rất đơn giản (không lồng quy tắc), đủ cho CSS của dự án. Chuỗi trong dấu nháy
 * không làm ngắt khai báo (ví dụ url("data:...;base64,...")).
 */
export function parseDeclarations(source) {
  const text = stripComments(source);
  const lineOf = makeLineFinder(text);
  const decls = [];
  const stack = [];
  let start = 0;
  let quote = null;
  const flush = (end) => {
    const raw = text.slice(start, end);
    const m = DECL.exec(raw.trim());
    if (!m) return;
    const idx = start + (raw.length - raw.trimStart().length);
    let value = m[2];
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    const top = stack[stack.length - 1];
    decls.push({
      prop: m[1],
      value,
      line: lineOf(idx),
      important,
      keyframes: stack.some((f) => f.keyframes),
      selector: top ? top.selector : '',
    });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') {
      const selector = text.slice(start, i).trim();
      const keyframes = /^@(-[a-z]+-)?keyframes\b/.test(selector);
      stack.push({ selector: selector.replace(/\s+/g, ' ').slice(0, 120), keyframes });
      start = i + 1;
    } else if (ch === ';' || ch === '}') {
      flush(i);
      if (ch === '}') stack.pop();
      start = i + 1;
    }
  }
  return decls;
}

/** Tìm mọi var(...) kể cả lồng nhau. Trả về tên và fallback (null nếu không có). */
export function extractVarCalls(value) {
  const out = [];
  const re = /(^|[^\w-])var\(/gi;
  let m;
  while ((m = re.exec(value))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    let comma = -1;
    for (let j = open; j < value.length; j++) {
      const ch = value[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (ch === ',' && depth === 1 && comma < 0) comma = j;
    }
    if (end < 0) break;
    const name = value.slice(open + 1, comma < 0 ? end : comma).trim();
    const fallback = comma < 0 ? null : value.slice(comma + 1, end).trim();
    out.push({ name, fallback });
  }
  return out;
}

/** Tách giá trị theo khoảng trắng và '/' ở mức ngoài cùng (giữ nguyên calc(...) và var(...)). */
export function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && (/\s/.test(ch) || ch === '/')) {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

const PX = /^(-?\d*\.?\d+)px$/i;
const REM = /^(-?\d*\.?\d+)rem$/i;

function num(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/** Bảng token: tên biến → giá trị chữ (chỉ khi giá trị là một literal). Lấy khai báo đầu tiên (sáng). */
export function tokenLiterals(tokensText) {
  const map = new Map();
  for (const d of parseDeclarations(tokensText)) {
    if (!d.prop.startsWith('--') || map.has(d.prop)) continue;
    const literal = !/var\(|calc\(/i.test(d.value) ? d.value.trim() : null;
    map.set(d.prop, literal);
  }
  return map;
}

function normalizeLiteral(v) {
  return v.replace(/\s+/g, '').toLowerCase();
}

/**
 * Kiểm tra một khai báo, trả về danh sách phát hiện (chưa có file).
 * `ctx`: { tokens: Map (tên → literal|null), localNames: Set, tsxNames: Set }.
 */
export function checkDeclaration(decl, ctx) {
  const found = [];
  const add = (kind, message, extra = {}) =>
    found.push({
      line: decl.line,
      kind,
      prop: decl.prop,
      value: decl.value,
      selector: decl.selector,
      message,
      ...extra,
    });

  // Khai báo biến CSS (--x: ...) là định nghĩa token, không phải chỗ dùng: bỏ qua px.
  const isCustomProp = decl.prop.startsWith('--');

  for (const { name, fallback } of extractVarCalls(decl.value)) {
    const known = ctx.tokens.has(name) || ctx.localNames.has(name) || ctx.tsxNames.has(name);
    if (!known) {
      add(
        'var-undefined',
        `var(${name}) không định nghĩa${fallback === null ? '' : `, fallback ${fallback}`}`,
      );
    } else if (ctx.tokens.has(name) && fallback !== null) {
      const literal = ctx.tokens.get(name);
      if (literal !== null && normalizeLiteral(literal) !== normalizeLiteral(fallback)) {
        add(
          'var-fallback-mismatch',
          `fallback ${fallback} khác giá trị của ${name} (${literal}); sai khi token không có`,
        );
      } else {
        add('var-fallback-redundant', `fallback thừa: ${name} đã có trong tokens.css`);
      }
    }
  }

  if (decl.important) add('important', '!important');

  // Trong @keyframes px là chuyển động tự do; calc() có px lẫn % nên không đoán được thang.
  if (decl.keyframes || isCustomProp || decl.value.includes('calc(')) return found;

  const prop = decl.prop.toLowerCase();
  for (const tok of splitTopLevel(decl.value)) {
    const rem = REM.exec(tok);
    if (rem) {
      const px = Number(rem[1]) * 16;
      add('rem', `${tok} = ${num(px)}px (rem không có cỡ gốc, html không đặt font-size)`, {
        token: tok,
      });
      continue;
    }
    const pm = PX.exec(tok);
    if (!pm) continue;
    const v = Number(pm[1]);
    if (FONT_PROP.test(prop)) {
      const inScale = FONT_SCALE.includes(v);
      add('font-size', `font-size ${tok} (${inScale ? 'trong thang' : 'ngoài thang'})`, {
        token: tok,
        inScale,
      });
    } else if (SPACE_PROP.test(prop)) {
      if (v < 0) {
        add('spacing', `${tok} âm: sửa tay, không thay bằng token`, {
          token: tok,
          negative: true,
        });
      } else if (v !== 1 && !SPACE_SCALE.includes(v)) {
        add('spacing', `${tok} ngoài thang khoảng cách`, { token: tok, negative: false });
      }
    } else if (RADIUS_PROP.test(prop)) {
      if (v > 0 && v !== 999 && !RADIUS_SCALE.includes(v)) {
        add('radius', `${tok} ngoài thang bo góc`, { token: tok });
      }
    } else if (HEIGHT_PROP.test(prop)) {
      if (
        v >= CONTROL_HEIGHT_RANGE[0] &&
        v <= CONTROL_HEIGHT_RANGE[1] &&
        !CONTROL_HEIGHTS.includes(v)
      ) {
        add('height', `${tok} ngoài thang điều khiển (26/32/38)`, { token: tok });
      }
    }
  }
  return found;
}

/**
 * Kiểm tra toàn bộ nguồn. Hàm thuần: không đọc đĩa.
 * @param {{ tokensText: string, cssFiles: {file:string,text:string}[], tsxTexts: string[],
 *           targets: {file:string,text:string}[] }} input
 */
export function auditSources({ tokensText, cssFiles, tsxTexts, targets }) {
  const tokens = tokenLiterals(tokensText);
  const localNames = new Set();
  for (const { text } of cssFiles) {
    for (const d of parseDeclarations(text)) if (d.prop.startsWith('--')) localNames.add(d.prop);
  }
  const tsxNames = new Set();
  for (const text of tsxTexts) {
    for (const m of text.matchAll(/['"`]--([A-Za-z0-9_-]+)['"`]/g)) tsxNames.add(`--${m[1]}`);
  }
  const ctx = { tokens, localNames, tsxNames };

  const findings = [];
  for (const { file, text } of targets) {
    if (/(^|[\\/])styles[\\/]tokens\.css$/.test(file)) continue;
    for (const decl of parseDeclarations(text)) {
      for (const f of checkDeclaration(decl, ctx)) findings.push({ file, ...f });
    }
  }

  return { findings, summary: summarize(findings) };
}

export function summarize(findings) {
  const byKind = {};
  const perFile = new Map();
  for (const f of findings) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (!perFile.has(f.file)) perFile.set(f.file, { file: f.file, total: 0, byKind: {} });
    const pf = perFile.get(f.file);
    pf.total++;
    pf.byKind[f.kind] = (pf.byKind[f.kind] ?? 0) + 1;
  }
  const files = [...perFile.values()].sort(
    (a, b) => b.total - a.total || a.file.localeCompare(b.file),
  );
  return { total: findings.length, byKind, files };
}

// ---------- Dòng lệnh ----------

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(REPO_ROOT, 'apps', 'ui', 'src');
const TOKENS = path.join(SRC_DIR, 'app', 'styles', 'tokens.css');

function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

export function runCli(argv) {
  const asJson = argv.includes('--json');
  const args = argv.filter((a) => !a.startsWith('--'));
  const targetPaths = args.length ? args.map((a) => path.resolve(a)) : [SRC_DIR];

  const all = walk(SRC_DIR);
  const cssFiles = all
    .filter((p) => p.endsWith('.css'))
    .map((p) => ({ file: rel(p), text: fs.readFileSync(p, 'utf8') }));
  const tsxTexts = all.filter((p) => /\.(ts|tsx)$/.test(p)).map((p) => fs.readFileSync(p, 'utf8'));

  const targetFiles = new Set();
  for (const t of targetPaths) {
    if (!fs.existsSync(t)) throw new Error(`Không thấy: ${t}`);
    const list = fs.statSync(t).isDirectory() ? walk(t) : [t];
    for (const p of list) if (p.endsWith('.css')) targetFiles.add(p);
  }
  const targets = [...targetFiles].sort().map((p) => ({
    file: rel(p),
    text: fs.readFileSync(p, 'utf8'),
  }));

  const { findings, summary } = auditSources({
    tokensText: fs.readFileSync(TOKENS, 'utf8'),
    cssFiles,
    tsxTexts,
    targets,
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ summary, findings }, null, 2)}\n`);
    return;
  }
  const out = [];
  out.push(`Báo cáo CSS: ${summary.total} phát hiện trong ${summary.files.length} file`);
  out.push(
    'Theo loại: ' +
      (Object.entries(summary.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || 'không có'),
  );
  out.push('');
  out.push('Tổng theo file (giảm dần):');
  for (const f of summary.files) {
    const parts = Object.entries(f.byKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    out.push(`  ${String(f.total).padStart(4)}  ${f.file}  (${parts})`);
  }
  out.push('');
  for (const f of summary.files) {
    out.push(`== ${f.file}`);
    for (const x of findings.filter((y) => y.file === f.file).sort((a, b) => a.line - b.line)) {
      const sel = x.selector ? `  [${x.selector}]` : '';
      out.push(`  L${x.line}  ${x.kind.padEnd(22)} ${x.prop}: ${x.value}  — ${x.message}${sel}`);
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2));
}
