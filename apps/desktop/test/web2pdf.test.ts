import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Web2PdfRequest } from '@chef/contracts';
import {
  DEFAULT_WEB2PDF_OPTIONS,
  Web2PdfError,
  allowRequest,
  convertToPdf,
  isInsideRoots,
  localKindOf,
  printToPdfOptions,
  remoteUrl,
  validateOptions,
  validateRequest,
  type RenderJob,
  type Web2PdfDeps,
} from '../src/main/web2pdf';

const ROOT = path.resolve('/work');
const OUT = path.join(ROOT, 'out.pdf');
const MD = path.join(ROOT, 'docs', 'ghi-chu.md');
const real = (p: string): string | null => p;

describe('validateOptions', () => {
  it('fills in the defaults (A4, 15 mm margins, backgrounds on)', () => {
    expect(validateOptions(undefined)).toEqual(DEFAULT_WEB2PDF_OPTIONS);
    expect(DEFAULT_WEB2PDF_OPTIONS.pageSize).toBe('A4');
  });

  it('refuses unknown keys and out-of-range values', () => {
    expect(() => validateOptions({ header: true })).toThrow(/unknown option/);
    expect(() => validateOptions({ pageSize: 'A3' })).toThrow(/pageSize/);
    expect(() => validateOptions({ scale: 3 })).toThrow(/scale/);
    expect(() => validateOptions({ marginsMm: { top: 80 } })).toThrow(/margin top/);
    expect(() => validateOptions({ landscape: 'yes' })).toThrow(/landscape/);
  });
});

describe('printToPdfOptions', () => {
  it('maps the options to Electron printToPDF options (margins in inches)', () => {
    const p = printToPdfOptions({
      pageSize: 'Letter',
      landscape: true,
      marginsMm: { top: 25.4, right: 0, bottom: 12.7, left: 50.8 },
      printBackground: false,
      scale: 0.5,
      headerFooter: false,
    });
    expect(p).toEqual({
      pageSize: 'Letter',
      landscape: true,
      printBackground: false,
      scale: 0.5,
      margins: { top: 1, bottom: 0.5, left: 2, right: 0 },
      preferCSSPageSize: false,
    });
  });

  it('adds the page-number footer only when headerFooter is on', () => {
    const on = printToPdfOptions({ ...DEFAULT_WEB2PDF_OPTIONS, headerFooter: true });
    expect(on.displayHeaderFooter).toBe(true);
    expect(on.footerTemplate).toContain('pageNumber');
    expect(on.footerTemplate).toContain('totalPages');
    expect(printToPdfOptions(DEFAULT_WEB2PDF_OPTIONS).displayHeaderFooter).toBeUndefined();
  });
});

describe('validateRequest', () => {
  const base = { kind: 'markdown', source: MD, outputPath: OUT };

  it('accepts a local request and normalises the output path', () => {
    const req = validateRequest({ ...base, outputPath: path.join(ROOT, 'a', '..', 'out.PDF') });
    expect(req.kind).toBe('markdown');
    expect(req.outputPath).toBe(OUT.replace(/out\.pdf$/, 'out.PDF'));
    expect(req.confirmed).toBe(false);
    expect(req.options).toEqual(DEFAULT_WEB2PDF_OPTIONS);
  });

  it('rejects unknown kinds, relative or non-PDF outputs and NUL bytes', () => {
    expect(() => validateRequest({ ...base, kind: 'script' })).toThrow(Web2PdfError);
    expect(() => validateRequest({ ...base, outputPath: 'out.pdf' })).toThrow(/absolute/);
    expect(() => validateRequest({ ...base, outputPath: path.join(ROOT, 'x.exe') })).toThrow(/pdf/);
    expect(() => validateRequest({ ...base, source: `${MD}\0` })).toThrow(/NUL/);
    expect(() => validateRequest('nope')).toThrow(/object/);
  });
});

describe('remoteUrl and localKindOf', () => {
  it('accepts only http and https pages', () => {
    expect(remoteUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(remoteUrl('http://example.com')).toBe('http://example.com/');
    expect(() => remoteUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => remoteUrl('javascript:alert(1)')).toThrow(/http/);
    expect(() => remoteUrl('not a url')).toThrow(/valid URL/);
  });

  it('chooses Markdown or HTML by extension for kind "file"', () => {
    expect(localKindOf('a.HTML', 'file')).toBe('html');
    expect(localKindOf('a.md', 'file')).toBe('markdown');
    expect(localKindOf('a.markdown', 'file')).toBe('markdown');
    expect(() => localKindOf('a.exe', 'file')).toThrow(/must be/);
    expect(localKindOf('a.txt', 'markdown')).toBe('markdown');
  });
});

describe('isInsideRoots and allowRequest', () => {
  const root = path.resolve('/docs');

  it('accepts files inside a root and refuses escapes and symlinks that leave it', () => {
    const map: Record<string, string> = {
      [path.join(root, 'a.png')]: path.join(root, 'a.png'),
      [path.join(root, 'link.png')]: path.resolve('/secret/key.png'),
    };
    const rp = (p: string) => map[p] ?? (p.startsWith(root) ? p : null);
    expect(isInsideRoots(path.join(root, 'a.png'), [root], rp)).toBe(true);
    expect(isInsideRoots(path.join(root, 'link.png'), [root], rp)).toBe(false);
    expect(isInsideRoots(path.resolve('/etc/hosts'), [root], rp)).toBe(false);
    expect(isInsideRoots(path.join(root, 'missing.png'), [root], () => null)).toBe(false);
  });

  it('allows file: only inside the job roots, http(s) only for remote jobs, and nothing else', () => {
    const local = { allowRemote: false, readRoots: [root] };
    const inside = pathToFileURL(path.join(root, 'x.png')).href;
    const outside = pathToFileURL(path.resolve('/other/x.png')).href;
    expect(allowRequest(inside, local, real)).toBe(true);
    expect(allowRequest(outside, local, real)).toBe(false);
    expect(allowRequest('https://evil.test/x.js', local, real)).toBe(false);
    expect(allowRequest('https://ok.test/', { allowRemote: true, readRoots: [] }, real)).toBe(true);
    expect(allowRequest('ws://x', { allowRemote: true, readRoots: [] }, real)).toBe(false);
    expect(allowRequest('data:image/png;base64,AAAA', local, real)).toBe(true);
    expect(allowRequest('not a url', local, real)).toBe(false);
  });
});

/** Fake dependencies: a folder that exists, a source file the user picked, and a fake renderer. */
function fakeDeps(over: Partial<Web2PdfDeps> = {}) {
  const files = new Map<string, string>([[MD, '# Xin chào\n\n![ảnh](a.png)']]);
  const written = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const jobs: RenderJob[] = [];
  const deps: Web2PdfDeps = {
    render: async (job) => {
      jobs.push(job);
      return Buffer.from('%PDF-1.7 fake');
    },
    stat: async (p) => {
      if (p === ROOT || p === path.dirname(OUT) || p === path.dirname(MD)) {
        return { isFile: false, isDirectory: true, size: 0 };
      }
      if (files.has(p)) return { isFile: true, isDirectory: false, size: files.get(p)!.length };
      return null;
    },
    readText: async (p) => files.get(p) ?? '',
    writeBytes: async (p, data) => {
      written.set(p, data);
    },
    remove: async (p) => {
      removed.push(p);
    },
    isAllowed: (p) => p === MD,
    tempDir: path.join(ROOT, 'cache'),
    fonts: null,
    newId: () => 'id1',
    ...over,
  };
  return { deps, jobs, written, removed, files };
}

const req = (over: Partial<Web2PdfRequest> = {}): Web2PdfRequest => ({
  kind: 'markdown',
  source: MD,
  outputPath: OUT,
  confirmed: false,
  options: DEFAULT_WEB2PDF_OPTIONS,
  ...over,
});

describe('convertToPdf', () => {
  it('converts Markdown through a temporary HTML file with JavaScript off, then removes it', async () => {
    const f = fakeDeps();
    const res = await convertToPdf(req(), f.deps);
    const size = Buffer.from('%PDF-1.7 fake').length;
    expect(res).toEqual({ outputPath: OUT, sizeBytes: size });
    expect(f.written.get(OUT)?.length).toBe(size);
    const job = f.jobs[0]!;
    expect(job.javascript).toBe(false);
    expect(job.allowRemote).toBe(false);
    expect(job.readRoots).toContain(path.dirname(MD));
    expect(job.file).toBe(path.join(ROOT, 'cache', 'web2pdf-id1.html'));
    expect(f.removed).toEqual([job.file]);
  });

  it('writes the rendered document (not the raw Markdown) to the temporary file', async () => {
    const f = fakeDeps({
      writeBytes: async (p, data) => {
        f.written.set(p, data);
      },
    });
    await convertToPdf(req(), f.deps);
    const tmp = path.join(ROOT, 'cache', 'web2pdf-id1.html');
    const html = Buffer.from(f.written.get(tmp)!).toString('utf8');
    expect(html).toContain('<h1>Xin chào</h1>');
    expect(html).toContain('<img src="');
    expect(html).not.toContain('# Xin chào');
  });

  it('loads a local HTML file directly and only allows its folder', async () => {
    const htmlPath = path.join(ROOT, 'docs', 'trang.html');
    const f = fakeDeps({
      isAllowed: (p) => p === htmlPath,
      stat: async (p) =>
        p === htmlPath
          ? { isFile: true, isDirectory: false, size: 10 }
          : p === path.dirname(OUT)
            ? { isFile: false, isDirectory: true, size: 0 }
            : null,
    });
    await convertToPdf(req({ kind: 'html', source: htmlPath }), f.deps);
    const job = f.jobs[0]!;
    expect(job.file).toBe(htmlPath);
    expect(job.readRoots).toEqual([path.dirname(htmlPath)]);
    expect(job.javascript).toBe(false);
  });

  it('refuses a remote page unless the user confirmed it', async () => {
    const f = fakeDeps();
    const r = { kind: 'url' as const, source: 'https://example.com/', outputPath: OUT };
    await expect(convertToPdf(req(r), f.deps)).rejects.toMatchObject({
      code: 'REMOTE_NOT_CONFIRMED',
    });
    expect(f.jobs).toHaveLength(0);
  });

  it('prints a confirmed remote page with JavaScript on and remote loads allowed', async () => {
    const f = fakeDeps();
    await convertToPdf(
      req({ kind: 'url', source: 'https://example.com/a', outputPath: OUT, confirmed: true }),
      f.deps,
    );
    const job = f.jobs[0]!;
    expect(job.url).toBe('https://example.com/a');
    expect(job.allowRemote).toBe(true);
    expect(job.javascript).toBe(true);
    expect(job.file).toBeUndefined();
  });

  it('refuses a file the user did not pick, a missing file and an oversized file', async () => {
    const f = fakeDeps({ isAllowed: () => false });
    await expect(convertToPdf(req(), f.deps)).rejects.toMatchObject({ code: 'FILE_NOT_ALLOWED' });

    const g = fakeDeps({
      stat: async (p) => (p === ROOT ? { isFile: false, isDirectory: true, size: 0 } : null),
    });
    await expect(convertToPdf(req(), g.deps)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });

    const h = fakeDeps({
      stat: async (p) =>
        p === MD
          ? { isFile: true, isDirectory: false, size: 21 * 1024 * 1024 }
          : p === path.dirname(OUT)
            ? { isFile: false, isDirectory: true, size: 0 }
            : null,
    });
    await expect(convertToPdf(req(), h.deps)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('refuses an output folder that does not exist', async () => {
    const f = fakeDeps({ stat: async () => null });
    await expect(convertToPdf(req(), f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('fails when nothing was printed', async () => {
    const f = fakeDeps({ render: async () => Buffer.alloc(0) });
    await expect(convertToPdf(req(), f.deps)).rejects.toMatchObject({ code: 'RENDER_FAILED' });
  });

  it('uses the bundled fonts as file URLs in the Markdown stylesheet', async () => {
    const fonts = { regular: path.join(ROOT, 'f', 'R.ttf'), bold: path.join(ROOT, 'f', 'B.ttf') };
    const f = fakeDeps({ fonts });
    const written: string[] = [];
    f.deps.writeBytes = async (p, data) => {
      written.push(Buffer.from(data).toString('utf8'));
      f.written.set(p, data);
    };
    await convertToPdf(req(), f.deps);
    expect(written[0]).toContain(`url('${pathToFileURL(fonts.regular).href}')`);
  });

  describe('timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('aborts the job and fails after the timeout', async () => {
      let signal: AbortSignal | undefined;
      const f = fakeDeps({
        timeoutMs: 60_000,
        render: (job) => {
          signal = job.signal;
          return new Promise<Buffer>(() => undefined); // never finishes
        },
      });
      const run = convertToPdf(req(), f.deps);
      const assertion = expect(run).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
    });
  });
});
