import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  localImageUrl,
  markdownToHtml,
  renderMarkdownDocument,
  safeLinkHref,
} from '../src/main/markdown';

const ctx = (baseDir: string | null = null) => ({ baseDir });
const md = (s: string, baseDir: string | null = null) => markdownToHtml(s, ctx(baseDir));

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('block syntax', () => {
  it('renders ATX headings with levels 1-6', () => {
    expect(md('# Một\n\n### Ba ###')).toBe('<h1>Một</h1>\n<h3>Ba</h3>');
  });

  it('joins paragraph lines and separates paragraphs on blank lines', () => {
    expect(md('dòng một\ndòng hai\n\nđoạn mới')).toBe('<p>dòng một dòng hai</p>\n<p>đoạn mới</p>');
  });

  it('renders unordered, ordered and continued list items', () => {
    expect(md('- a\n- b\n  tiếp\n\n1. x\n2. y')).toBe(
      '<ul><li>a</li><li>b tiếp</li></ul>\n<ol><li>x</li><li>y</li></ol>',
    );
  });

  it('keeps fenced code escaped and tags its language', () => {
    const html = md('```js\nif (a < b) { alert("<img onerror=x>") }\n```');
    expect(html).toBe(
      '<pre><code class="language-js">if (a &lt; b) { alert(&quot;&lt;img onerror=x&gt;&quot;) }</code></pre>',
    );
  });

  it('drops an unsafe language tag', () => {
    expect(md('```"><script>\nx\n```')).toBe('<pre><code>x</code></pre>');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(md('> trích dẫn\n> tiếp\n\n---')).toBe(
      '<blockquote><p>trích dẫn tiếp</p></blockquote>\n<hr>',
    );
  });

  it('renders pipe tables with alignment', () => {
    expect(md('| Tên | SL |\n| :--- | ---: |\n| Bút | 3 |')).toBe(
      '<table><thead><tr><th style="text-align:left">Tên</th><th style="text-align:right">SL</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">Bút</td><td style="text-align:right">3</td></tr></tbody></table>',
    );
  });

  it('does not treat a lone pipe line as a table', () => {
    expect(md('a | b')).toBe('<p>a | b</p>');
  });
});

describe('inline syntax', () => {
  it('renders emphasis, strong, strikethrough and code spans', () => {
    expect(md('*nghiêng* **đậm** ~~gạch~~ `mã`')).toBe(
      '<p><em>nghiêng</em> <strong>đậm</strong> <del>gạch</del> <code>mã</code></p>',
    );
  });

  it('does not emphasise intraword underscores', () => {
    expect(md('snake_case_name')).toBe('<p>snake_case_name</p>');
  });

  it('renders http(s) and mailto links', () => {
    expect(md('[site](https://example.com/a?b=1&c=2) [mail](mailto:a@b.vn)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2">site</a> <a href="mailto:a@b.vn">mail</a></p>',
    );
  });

  it('shows the label only for javascript:, data: and relative links', () => {
    expect(md('[x](javascript:alert(1))')).toBe('<p>x</p>');
    expect(md('[x](JavaScript:alert(1))')).toBe('<p>x</p>');
    expect(md('[x](data:text/html,<script>)')).toBe('<p>x</p>');
    expect(md('[x](../secret.pdf)')).toBe('<p>x</p>');
  });

  it('escapes raw HTML injection attempts in paragraphs', () => {
    expect(md('<script>alert(1)</script> <img src=x onerror=alert(1)>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p>',
    );
  });

  it('cannot break out of a link attribute', () => {
    const html = md('[a](https://x.test/"onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('href="https://x.test/&quot;onmouseover=&quot;alert(1)');
  });

  it('honours backslash escapes', () => {
    expect(md('\\*không nhấn\\*')).toBe('<p>*không nhấn*</p>');
  });

  it('keeps unbalanced delimiters as text', () => {
    expect(md('a * b [c')).toBe('<p>a * b [c</p>');
  });
});

describe('images', () => {
  it('turns a relative image inside the document folder into a file URL', () => {
    const base = path.resolve('/docs/notes');
    const html = md('![hình](img/a.png)', base);
    expect(html).toBe(
      `<p><img src="${escapeHtml(pathToFileURL(path.join(base, 'img', 'a.png')).href)}" alt="hình"></p>`,
    );
  });

  it('refuses images outside the document folder, absolute paths and remote URLs', () => {
    const base = path.resolve('/docs/notes');
    expect(md('![x](../../etc/passwd.png)', base)).toBe(
      '<p><span class="img-missing">[x]</span></p>',
    );
    expect(md(`![x](${path.resolve('/etc/passwd.png').replace(/\\/g, '/')})`, base)).toContain(
      'img-missing',
    );
    expect(md('![x](https://evil.test/p.png)', base)).toContain('img-missing');
    expect(md('![x](file:///C:/Windows/win.ini)', base)).toContain('img-missing');
    expect(md('![x](//evil.test/p.png)', base)).toContain('img-missing');
  });

  it('renders no images at all without a document folder', () => {
    expect(md('![x](a.png)')).toBe('<p><span class="img-missing">[x]</span></p>');
  });
});

describe('safeLinkHref / localImageUrl', () => {
  it('accepts only http, https and mailto', () => {
    expect(safeLinkHref('https://a.b')).toBe('https://a.b');
    expect(safeLinkHref('http://a.b')).toBe('http://a.b');
    expect(safeLinkHref('mailto:x@y.z')).toBe('mailto:x@y.z');
    expect(safeLinkHref('java\tscript:x')).toBeNull();
    expect(safeLinkHref('vbscript:x')).toBeNull();
    expect(safeLinkHref('file:///etc/passwd')).toBeNull();
    expect(safeLinkHref('')).toBeNull();
  });

  it('refuses images when the base folder is unknown', () => {
    expect(localImageUrl('a.png', null)).toBeNull();
  });
});

describe('renderMarkdownDocument', () => {
  it('wraps the body in a document with a strict CSP and escaped title', () => {
    const html = renderMarkdownDocument({
      markdown: '# Tiêu đề',
      baseDir: null,
      title: '<b>x</b>',
      fonts: { regular: 'file:///f/R.ttf', bold: 'file:///f/B.ttf' },
    });
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain('script-src');
    expect(html).toContain('<title>&lt;b&gt;x&lt;/b&gt;</title>');
    expect(html).toContain('<h1>Tiêu đề</h1>');
    expect(html).toContain("src:url('file:///f/R.ttf')");
  });

  it('never emits a script element, even when the source has one', () => {
    const html = renderMarkdownDocument({
      markdown: '<script>alert(1)</script>\n\n```\n</script>\n```',
      baseDir: null,
      title: 't',
      fonts: null,
    });
    expect(html.toLowerCase()).not.toMatch(/<script[\s>]/);
  });

  it('rejects oversized sources', () => {
    expect(() => markdownToHtml('a'.repeat(2_000_001), ctx())).toThrow(RangeError);
  });
});
