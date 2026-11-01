/**
 * Small, hand-written Markdown → HTML converter for "Trang web / Markdown → PDF" (T5.06).
 *
 * Security model: every piece of text is HTML-escaped and raw HTML is never passed through, so
 * `<script>`, `onerror=` and friends are shown as plain text. Links are emitted only for http(s)
 * and mailto. Images are emitted only for files inside the document's own folder (`baseDir`).
 * Supported: ATX headings, paragraphs, emphasis, strong, strikethrough, code spans and fenced code,
 * ordered and unordered lists (nested lists are flattened), blockquotes, rules, pipe tables,
 * links and images. Anything else is plain text.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Largest Markdown source accepted (characters). */
export const MAX_MARKDOWN_CHARS = 2_000_000;
const MAX_QUOTE_DEPTH = 4;
const MAX_INLINE_DEPTH = 6;
/** Bounded look-ahead for closing delimiters, so pathological input stays linear-ish. */
const MAX_SCAN = 2000;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** `href` when it is safe to emit in a link, otherwise null (relative and other schemes too). */
export function safeLinkHref(raw: string): string | null {
  const href = raw.trim();
  // Control characters are refused on purpose.
  // eslint-disable-next-line no-control-regex
  if (href.length === 0 || href.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(href)) return null;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? href : null;
}

/**
 * `file://` URL of an image referenced by a relative path, when it lies inside `baseDir`.
 * Absolute paths, any URL scheme and `..` escapes are refused.
 */
export function localImageUrl(src: string, baseDir: string | null): string | null {
  if (baseDir === null) return null;
  const s = src.trim();
  // eslint-disable-next-line no-control-regex -- control characters are refused on purpose
  if (s.length === 0 || s.length > 2048 || /[\u0000-\u001f]/.test(s)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) || s.startsWith('//') || s.startsWith('\\\\'))
    return null;
  let decoded: string;
  try {
    decoded = decodeURI(s);
  } catch {
    return null;
  }
  if (path.isAbsolute(decoded)) return null;
  const root = path.resolve(baseDir);
  const abs = path.resolve(root, decoded);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return pathToFileURL(abs).href;
}

export interface InlineContext {
  baseDir: string | null;
}

/** Index of the bracket that closes `src[start]`, honouring nesting; -1 when none nearby. */
function findClose(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  const limit = Math.min(src.length, start + MAX_SCAN);
  for (let j = start; j < limit; j++) {
    const ch = src[j];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Index of the closing emphasis delimiter for an opener ending right before `start`. */
function findDelim(src: string, start: number, delim: string, marker: string): number {
  const limit = Math.min(src.length, start + MAX_SCAN);
  let j = src.indexOf(delim, start);
  while (j !== -1 && j < limit) {
    const before = src[j - 1] ?? ' ';
    const after = src[j + delim.length] ?? ' ';
    const single = delim.length === 1;
    const ok =
      !/\s/.test(before) && !(marker === '_' && /\w/.test(after)) && !(single && after === marker);
    if (ok && j > start) return j;
    j = src.indexOf(delim, j + 1);
  }
  return -1;
}

function imageHtml(alt: string, dest: string, ctx: InlineContext): string {
  const url = localImageUrl(dest, ctx.baseDir);
  if (url === null) return `<span class="img-missing">[${escapeHtml(alt || 'image')}]</span>`;
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`;
}

/** Link destination without its optional title: `<url>` or `url "title"`. */
function destinationOf(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  return s.split(/\s+/)[0] ?? '';
}

/** Renders the inline Markdown of one paragraph, heading, cell or list item. */
export function renderInline(src: string, ctx: InlineContext, depth = 0): string {
  if (depth > MAX_INLINE_DEPTH) return escapeHtml(src);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    if (c === '\\' && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1]!)) {
      out += escapeHtml(src[i + 1]!);
      i += 2;
      continue;
    }

    if (c === '`') {
      let n = 1;
      while (src[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      const end = src.indexOf(fence, i + n);
      if (end !== -1 && src[end + n] !== '`') {
        out += `<code>${escapeHtml(src.slice(i + n, end).trim())}</code>`;
        i = end + n;
        continue;
      }
      out += escapeHtml(fence);
      i += n;
      continue;
    }

    if (c === '!' && src[i + 1] === '[') {
      const close = findClose(src, i + 1, '[', ']');
      if (close !== -1 && src[close + 1] === '(') {
        const paren = findClose(src, close + 1, '(', ')');
        if (paren !== -1) {
          const alt = src.slice(i + 2, close);
          out += imageHtml(alt, destinationOf(src.slice(close + 2, paren)), ctx);
          i = paren + 1;
          continue;
        }
      }
    }

    if (c === '[') {
      const close = findClose(src, i, '[', ']');
      if (close !== -1 && src[close + 1] === '(') {
        const paren = findClose(src, close + 1, '(', ')');
        if (paren !== -1) {
          const inner = renderInline(src.slice(i + 1, close), ctx, depth + 1);
          const href = safeLinkHref(destinationOf(src.slice(close + 2, paren)));
          out += href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
          i = paren + 1;
          continue;
        }
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const delim = c === '~' ? (src[i + 1] === '~' ? '~~' : '') : src[i + 1] === c ? c + c : c;
      const start = i + delim.length;
      const wordBefore = c === '_' && /\w/.test(src[i - 1] ?? '');
      if (delim !== '' && !wordBefore && start < src.length && !/\s/.test(src[start]!)) {
        const end = findDelim(src, start, delim, c);
        if (end !== -1) {
          const tag = c === '~' ? 'del' : delim.length === 2 ? 'strong' : 'em';
          out += `<${tag}>${renderInline(src.slice(start, end), ctx, depth + 1)}</${tag}>`;
          i = end + delim.length;
          continue;
        }
      }
    }

    out += escapeHtml(c);
    i++;
  }
  return out;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RULE_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^\s*([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isTableStart(line: string | undefined, next: string | undefined): boolean {
  return (
    line !== undefined &&
    next !== undefined &&
    line.includes('|') &&
    next.includes('|') &&
    TABLE_SEP_RE.test(next) &&
    splitRow(line).length === splitRow(next).length
  );
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    isTableStart(line, next)
  );
}

/** Splits a pipe-table row into trimmed cells; `\|` is a literal pipe. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function alignmentOf(sepCell: string): 'left' | 'center' | 'right' | null {
  const left = sepCell.startsWith(':');
  const right = sepCell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function renderTable(lines: string[], start: number, ctx: InlineContext): [string, number] {
  const header = splitRow(lines[start]!);
  const aligns = splitRow(lines[start + 1]!).map(alignmentOf);
  const styleOf = (col: number): string => {
    const a = aligns[col];
    return a ? ` style="text-align:${a}"` : '';
  };
  const head = header
    .map((cell, col) => `<th${styleOf(col)}>${renderInline(cell, ctx)}</th>`)
    .join('');
  let body = '';
  let i = start + 2;
  let rows = 0;
  while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|') && rows < 5000) {
    const cells = splitRow(lines[i]!);
    body += `<tr>${header
      .map((_h, col) => `<td${styleOf(col)}>${renderInline(cells[col] ?? '', ctx)}</td>`)
      .join('')}</tr>`;
    i++;
    rows++;
  }
  return [`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, i];
}

function renderBlocks(lines: string[], ctx: InlineContext, quoteDepth: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : '';
      const code: string[] = [];
      i++;
      const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i]!)) code.push(lines[i++]!);
      i++; // closing fence (or end of input)
      out.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '');
      out.push(`<h${level}>${renderInline(text.trim(), ctx)}</h${level}>`);
      i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        i++;
      }
      const body =
        quoteDepth < MAX_QUOTE_DEPTH
          ? renderBlocks(inner, ctx, quoteDepth + 1)
          : `<p>${renderInline(inner.join(' '), ctx)}</p>`;
      out.push(`<blockquote>${body}</blockquote>`);
      continue;
    }

    const item = LIST_RE.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        items.push(m[2]!);
        i++;
        // Indented continuation lines belong to the item (lazy continuation is not supported).
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !LIST_RE.test(lines[i]!)) {
          items[items.length - 1] += ` ${lines[i]!.trim()}`;
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((text) => `<li>${renderInline(text, ctx)}</li>`).join('');
      out.push(`<${tag}>${lis}</${tag}>`);
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const [html, next] = renderTable(lines, i, ctx);
      out.push(html);
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !isBlockStart(lines[i]!, lines[i + 1])) {
      para.push(lines[i]!.trim());
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '), ctx)}</p>`);
  }
  return out.join('\n');
}

/** Converts a Markdown source to an HTML fragment (no document wrapper). */
export function markdownToHtml(source: string, ctx: InlineContext): string {
  if (source.length > MAX_MARKDOWN_CHARS) throw new RangeError('Markdown source is too large');
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return renderBlocks(lines, ctx, 0);
}

/** Built-in print stylesheet. `fonts` are `file://` URLs of Be Vietnam Pro, or null. */
export function printCss(fonts: { regular: string; bold: string } | null): string {
  // Quotes and parentheses in the URL are percent-encoded so they cannot end the CSS string.
  const safeUrl = (url: string): string =>
    url.replace(/['()\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const face = (url: string, weight: number): string =>
    `@font-face{font-family:'Be Vietnam Pro';src:url('${safeUrl(url)}') format('truetype');font-weight:${weight};font-style:normal;}`;
  const fontFaces = fonts ? `${face(fonts.regular, 400)}${face(fonts.bold, 700)}` : '';
  return `${fontFaces}
html,body{margin:0;padding:0;}
body{font-family:'Be Vietnam Pro','Segoe UI',Arial,sans-serif;font-size:11pt;line-height:1.55;color:#111;}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.1em 0 .4em;}
h1{font-size:22pt;}h2{font-size:17pt;}h3{font-size:14pt;}h4,h5,h6{font-size:12pt;}
p{margin:.5em 0;}
a{color:#0b57d0;text-decoration:underline;}
code,pre{font-family:Consolas,'Courier New',monospace;font-size:9.5pt;}
pre{background:#f3f4f6;padding:8px 10px;white-space:pre-wrap;word-wrap:break-word;border-radius:4px;}
code{background:#f3f4f6;padding:0 3px;border-radius:3px;}
pre code{background:none;padding:0;}
blockquote{margin:.6em 0;padding:.1em 12px;border-left:3px solid #c4c7cc;color:#444;}
table{border-collapse:collapse;margin:.6em 0;width:100%;}
th,td{border:1px solid #c4c7cc;padding:4px 7px;vertical-align:top;}
th{background:#f0f2f5;}
img{max-width:100%;height:auto;}
.img-missing{color:#777;font-style:italic;}
hr{border:0;border-top:1px solid #c4c7cc;margin:1em 0;}
ul,ol{padding-left:1.4em;margin:.4em 0;}
del{color:#555;}`;
}

export interface MarkdownDocumentOptions {
  markdown: string;
  /** Folder of the Markdown file: the only folder images may come from. Null: no images. */
  baseDir: string | null;
  title: string;
  fonts: { regular: string; bold: string } | null;
}

/** Full HTML document for printing. The meta CSP forbids scripts and remote content. */
export function renderMarkdownDocument(o: MarkdownDocumentOptions): string {
  const body = markdownToHtml(o.markdown, { baseDir: o.baseDir });
  const title = escapeHtml(o.title.slice(0, 200) || 'Document');
  const csp = "default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; font-src file:";
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${printCss(o.fonts)}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
