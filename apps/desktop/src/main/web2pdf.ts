/**
 * "Trang web / Markdown / HTML → PDF" (T5.06), main-process side. Pure logic with injected
 * dependencies: the Electron printing window lives in `web2pdfRender.ts`.
 *
 * Rules enforced here (the renderer cannot bypass them):
 *  - remote pages only for `kind: 'url'` with `confirmed: true`, and only http(s);
 *  - local sources must have been picked by the user (allowlist) and are size-limited;
 *  - Markdown is converted here, so its HTML never comes from the renderer;
 *  - output must be an absolute `.pdf` path in an existing folder;
 *  - every job has a 60 s timeout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PrintToPDFOptions } from 'electron';
import type { Web2PdfKind, Web2PdfOptions, Web2PdfRequest, Web2PdfResult } from '@chef/contracts';
import { atomicWriteFile } from './fsutil';
import { renderMarkdownDocument } from './markdown';

export const WEB2PDF_TIMEOUT_MS = 60_000;
export const MAX_LOCAL_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;

export const DEFAULT_WEB2PDF_OPTIONS: Web2PdfOptions = {
  pageSize: 'A4',
  landscape: false,
  marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
  printBackground: true,
  scale: 1,
  headerFooter: false,
};

export type Web2PdfErrorCode =
  | 'INVALID_REQUEST'
  | 'REMOTE_NOT_CONFIRMED'
  | 'FILE_NOT_ALLOWED'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FILE'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'RENDER_FAILED';

export class Web2PdfError extends Error {
  constructor(
    readonly code: Web2PdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Web2PdfError';
  }
}

/** What the printing window must load and allow. */
export interface RenderJob {
  /** Remote page (kind `url`). */
  url?: string;
  /** Local file to load (HTML, or the Markdown rendered to a temporary HTML file). */
  file?: string;
  allowRemote: boolean;
  /** Folders a `file:` request may read from (checked against the real path). */
  readRoots: string[];
  javascript: boolean;
  printOptions: PrintToPDFOptions;
  signal: AbortSignal;
}

export interface Web2PdfDeps {
  render(job: RenderJob): Promise<Buffer>;
  /** Stat of a path, or null when it does not exist. */
  stat(p: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null>;
  readText(p: string): Promise<string>;
  writeBytes(p: string, data: Uint8Array): Promise<void>;
  remove(p: string): Promise<void>;
  /** Only sources the user picked (open dialog, OS open-file) may be read. */
  isAllowed(p: string): boolean;
  /** Folder for temporary HTML files. */
  tempDir: string;
  /** Font files for the Markdown style (null: the system fallback is used). */
  fonts: { regular: string; bold: string } | null;
  newId(): string;
  timeoutMs?: number;
  log?(message: string): void;
}

const ALLOWED_PAGE_SIZES = new Set(['A4', 'Letter']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(message: string): Web2PdfError {
  return new Web2PdfError('INVALID_REQUEST', message);
}

function boundedNumber(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw bad(`${name} must be a number from ${min} to ${max}`);
  }
  return v;
}

/** Validates the options object, filling defaults. Unknown keys are refused. */
export function validateOptions(v: unknown): Web2PdfOptions {
  const d = DEFAULT_WEB2PDF_OPTIONS;
  if (v === undefined || v === null) return structuredClone(d);
  if (!isPlainObject(v)) throw bad('options must be an object');
  const allowed = new Set([
    'pageSize',
    'landscape',
    'marginsMm',
    'printBackground',
    'scale',
    'headerFooter',
  ]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) throw bad(`unknown option ${k}`);
  const pageSize = v.pageSize ?? d.pageSize;
  if (typeof pageSize !== 'string' || !ALLOWED_PAGE_SIZES.has(pageSize)) {
    throw bad('pageSize must be A4 or Letter');
  }
  const landscape = v.landscape ?? d.landscape;
  const printBackground = v.printBackground ?? d.printBackground;
  const headerFooter = v.headerFooter ?? d.headerFooter;
  if (typeof landscape !== 'boolean') throw bad('landscape must be a boolean');
  if (typeof printBackground !== 'boolean') throw bad('printBackground must be a boolean');
  if (typeof headerFooter !== 'boolean') throw bad('headerFooter must be a boolean');
  const margins = v.marginsMm ?? d.marginsMm;
  if (!isPlainObject(margins)) throw bad('marginsMm must be an object');
  const marginsMm = {
    top: boundedNumber(margins.top ?? d.marginsMm.top, 0, 50, 'margin top'),
    right: boundedNumber(margins.right ?? d.marginsMm.right, 0, 50, 'margin right'),
    bottom: boundedNumber(margins.bottom ?? d.marginsMm.bottom, 0, 50, 'margin bottom'),
    left: boundedNumber(margins.left ?? d.marginsMm.left, 0, 50, 'margin left'),
  };
  const scale = boundedNumber(v.scale ?? d.scale, 0.1, 2, 'scale');
  return {
    pageSize: pageSize as 'A4' | 'Letter',
    landscape,
    marginsMm,
    printBackground,
    scale,
    headerFooter,
  };
}

const MM_PER_INCH = 25.4;

/** Options of `webContents.printToPDF` for validated options (margins in inches, as Electron expects). */
export function printToPdfOptions(o: Web2PdfOptions): PrintToPDFOptions {
  const out: PrintToPDFOptions = {
    pageSize: o.pageSize,
    landscape: o.landscape,
    printBackground: o.printBackground,
    scale: o.scale,
    margins: {
      top: o.marginsMm.top / MM_PER_INCH,
      bottom: o.marginsMm.bottom / MM_PER_INCH,
      left: o.marginsMm.left / MM_PER_INCH,
      right: o.marginsMm.right / MM_PER_INCH,
    },
    preferCSSPageSize: false,
  };
  if (o.headerFooter) {
    out.displayHeaderFooter = true;
    out.headerTemplate =
      '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="title"></span></div>';
    out.footerTemplate =
      '<div style="font-size:8px;width:100%;text-align:center;color:#666;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
  }
  return out;
}

const KINDS: readonly Web2PdfKind[] = ['url', 'html', 'markdown', 'file'];

/** Validates a request from the renderer (IPC input). */
export function validateRequest(input: unknown): Web2PdfRequest {
  if (!isPlainObject(input)) throw bad('request must be an object');
  const kind = input.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind as Web2PdfKind)) {
    throw bad('kind must be url, html, markdown or file');
  }
  if (
    typeof input.source !== 'string' ||
    input.source.length === 0 ||
    input.source.length > MAX_URL_LENGTH
  ) {
    throw bad('source must be a non-empty string');
  }
  if (input.source.includes('\0')) throw bad('source contains a NUL character');
  if (
    typeof input.outputPath !== 'string' ||
    input.outputPath.length === 0 ||
    input.outputPath.includes('\0')
  ) {
    throw bad('outputPath must be a string');
  }
  if (!path.isAbsolute(input.outputPath) || !/\.pdf$/i.test(input.outputPath)) {
    throw bad('outputPath must be an absolute .pdf path');
  }
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') {
    throw bad('confirmed must be a boolean');
  }
  return {
    kind: kind as Web2PdfKind,
    source: input.source,
    outputPath: path.normalize(input.outputPath),
    confirmed: input.confirmed === true,
    options: validateOptions(input.options),
  };
}

/** The http(s) URL of a `url` source, or a Web2PdfError. */
export function remoteUrl(source: string): string {
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    throw bad('source is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Web2PdfError('INVALID_REQUEST', 'only http and https pages can be converted');
  }
  return u.href;
}

/** Markdown or HTML chosen by the extension of a local file. */
export function localKindOf(file: string, kind: Web2PdfKind): 'html' | 'markdown' {
  const ext = path.extname(file).toLowerCase();
  if (kind === 'html') return 'html';
  if (kind === 'markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  throw new Web2PdfError('UNSUPPORTED_FILE', 'the file must be .html, .htm, .md or .markdown');
}

/**
 * True when `file` is inside one of `roots`, comparing real paths when they can be resolved.
 * A symlink inside a root that points outside is refused.
 */
export function isInsideRoots(
  file: string,
  roots: string[],
  realpath: (p: string) => string | null,
): boolean {
  const real = realpath(file);
  if (real === null) return false;
  return roots.some((root) => {
    const r = realpath(root) ?? path.resolve(root);
    const rel = path.relative(r, real);
    return rel === '' ? false : !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** Whether the printing window may load `url` (used by the Electron request filter). */
export function allowRequest(
  url: string,
  job: Pick<RenderJob, 'allowRemote' | 'readRoots'>,
  realpath: (p: string) => string | null,
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  switch (u.protocol) {
    case 'file:': {
      let file: string;
      try {
        file = fileURLToPath(u);
      } catch {
        return false;
      }
      return isInsideRoots(file, job.readRoots, realpath);
    }
    case 'http:':
    case 'https:':
      return job.allowRemote;
    case 'data:':
      return true;
    default:
      return false;
  }
}

/** Converts a validated request to a PDF file. Returns the output path and size. */
export async function convertToPdf(req: Web2PdfRequest, deps: Web2PdfDeps): Promise<Web2PdfResult> {
  const outDir = path.dirname(req.outputPath);
  const outStat = await deps.stat(outDir);
  if (!outStat?.isDirectory) throw bad('the output folder does not exist');
  const existing = await deps.stat(req.outputPath);
  if (existing?.isDirectory) throw bad('the output path is a folder');

  const options = validateOptions(req.options);
  const printOptions = printToPdfOptions(options);
  const controller = new AbortController();
  let tempHtml: string | null = null;
  let job: RenderJob;

  try {
    if (req.kind === 'url') {
      if (!req.confirmed) {
        throw new Web2PdfError(
          'REMOTE_NOT_CONFIRMED',
          'the user must confirm loading this web page',
        );
      }
      job = {
        url: remoteUrl(req.source),
        allowRemote: true,
        readRoots: [],
        javascript: true,
        printOptions,
        signal: controller.signal,
      };
    } else {
      const file = path.resolve(req.source);
      if (!deps.isAllowed(file)) {
        throw new Web2PdfError('FILE_NOT_ALLOWED', 'the file was not picked by the user');
      }
      const st = await deps.stat(file);
      if (!st?.isFile) throw new Web2PdfError('FILE_NOT_FOUND', 'the source file was not found');
      if (st.size > MAX_LOCAL_SOURCE_BYTES) {
        throw new Web2PdfError('TOO_LARGE', 'the source file is larger than 20 MB');
      }
      const local = localKindOf(file, req.kind);
      const folder = path.dirname(file);
      const fontRoots = deps.fonts ? [path.dirname(deps.fonts.regular)] : [];
      if (local === 'html') {
        job = {
          file,
          allowRemote: false,
          readRoots: [folder, ...fontRoots],
          javascript: false,
          printOptions,
          signal: controller.signal,
        };
      } else {
        const text = await deps.readText(file);
        const html = renderMarkdownDocument({
          markdown: text,
          baseDir: folder,
          title: path.basename(file),
          fonts: deps.fonts ? fontUrls(deps.fonts) : null,
        });
        tempHtml = path.join(deps.tempDir, `web2pdf-${deps.newId()}.html`);
        await deps.writeBytes(tempHtml, Buffer.from(html, 'utf8'));
        job = {
          file: tempHtml,
          allowRemote: false,
          readRoots: [folder, deps.tempDir, ...fontRoots],
          javascript: false,
          printOptions,
          signal: controller.signal,
        };
      }
    }

    const bytes = await withTimeout(
      deps.render(job),
      deps.timeoutMs ?? WEB2PDF_TIMEOUT_MS,
      controller,
    );
    if (bytes.length === 0) throw new Web2PdfError('RENDER_FAILED', 'nothing was printed');
    if (bytes.length > MAX_OUTPUT_BYTES)
      throw new Web2PdfError('TOO_LARGE', 'the PDF is too large');
    await deps.writeBytes(req.outputPath, bytes);
    deps.log?.(`web2pdf: ${req.kind} written, ${bytes.length} bytes`);
    return { outputPath: req.outputPath, sizeBytes: bytes.length };
  } finally {
    controller.abort();
    if (tempHtml) await deps.remove(tempHtml).catch(() => undefined);
  }
}

/** `file://` URLs of the bundled fonts, for the Markdown stylesheet. */
export function fontUrls(f: { regular: string; bold: string }): { regular: string; bold: string } {
  return { regular: pathToFileURL(f.regular).href, bold: pathToFileURL(f.bold).href };
}

/** Rejects after `ms` (and aborts the job) unless `p` settles first. */
function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Web2PdfError('TIMEOUT', 'the conversion took longer than 60 seconds'));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The IPC handler for `chef.convert.toPdf`: validates input, then converts with real files. */
export function createWeb2PdfHandler(o: {
  allowlist: { isAllowed(p: string): boolean };
  tempDir: string;
  fonts: { regular: string; bold: string } | null;
  render(job: RenderJob): Promise<Buffer>;
  log?(message: string): void;
}): (input: unknown) => Promise<Web2PdfResult> {
  return async (input) => {
    const req = validateRequest(input);
    await fs.promises.mkdir(o.tempDir, { recursive: true });
    const deps: Web2PdfDeps = {
      render: o.render,
      stat: async (p) => {
        try {
          const st = await fs.promises.stat(p);
          return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size };
        } catch {
          return null;
        }
      },
      readText: (p) => fs.promises.readFile(p, 'utf8'),
      writeBytes: (p, data) => atomicWriteFile(p, data),
      remove: (p) => fs.promises.rm(p, { force: true }),
      isAllowed: (p) => o.allowlist.isAllowed(p),
      tempDir: o.tempDir,
      fonts: o.fonts,
      newId: () => randomUUID(),
      ...(o.log ? { log: o.log } : {}),
    };
    return convertToPdf(req, deps);
  };
}
