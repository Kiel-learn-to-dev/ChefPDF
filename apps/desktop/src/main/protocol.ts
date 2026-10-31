/**
 * Custom protocols:
 *  - `chef-file://f/<encodeURIComponent(absPath)>`: allowlisted local files for the viewer
 *    (docs/CONTRACTS.md section 5), with byte-range support for pdf.js.
 *  - `chef-app://ui/...`: the built UI (or the fallback page), served with a strict CSP.
 * Handlers are pure (Fetch API Request -> Response); Electron wiring is injected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { PathAllowlist } from './allowlist';
import { APP_HOST, APP_SCHEME, FILE_HOST, FILE_SCHEME } from '../shared/ipc';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, Content-Encoding',
};

function textResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS, ...extra },
  });
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parses a single `Range: bytes=...` header. Returns null to serve the whole file. */
export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multiple or malformed ranges: ignore and send everything
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function streamBody(file: string, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
}

/** Decodes the absolute path out of a `chef-file` URL, or null when malformed. */
export function pathFromFileUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${FILE_SCHEME}:` || u.hostname !== FILE_HOST) return null;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
  const impl = platform === 'win32' ? path.win32 : path.posix;
  if (!p || p.includes('\0') || !impl.isAbsolute(p)) return null;
  return impl.normalize(p);
}

export function createFileHandler(
  allowlist: PathAllowlist,
  platform: NodeJS.Platform = process.platform,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return textResponse(405, 'Method Not Allowed');
    const file = pathFromFileUrl(req.url, platform);
    if (!file) return textResponse(400, 'Bad Request');
    if (!allowlist.isAllowed(file)) return textResponse(403, 'Forbidden');
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return textResponse(404, 'Not Found');
    }
    if (!stat.isFile()) return textResponse(404, 'Not Found');

    const size = stat.size;
    const base: Record<string, string> = {
      ...CORS_HEADERS,
      'Content-Type': contentTypeFor(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    const range = parseRange(req.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      return textResponse(416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${size}` });
    }
    const head = req.method === 'HEAD';
    if (range) {
      const length = range.end - range.start + 1;
      return new Response(head ? null : streamBody(file, range.start, range.end), {
        status: 206,
        headers: {
          ...base,
          'Content-Length': String(length),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }
    const body = head || size === 0 ? null : streamBody(file, 0, size - 1);
    return new Response(body, {
      status: 200,
      headers: { ...base, 'Content-Length': String(size) },
    });
  };
}

export interface AppHandlerOptions {
  /** Directory holding the UI build (index.html + assets). */
  root: string;
  /** Entry document inside `root` (index.html or fallback.html). */
  index: string;
  csp: string;
}

export function createAppHandler(o: AppHandlerOptions): (req: Request) => Promise<Response> {
  const root = path.resolve(o.root);
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return textResponse(405, 'Method Not Allowed');
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return textResponse(400, 'Bad Request');
    }
    if (u.protocol !== `${APP_SCHEME}:` || u.hostname !== APP_HOST)
      return textResponse(404, 'Not Found');
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname);
    } catch {
      return textResponse(400, 'Bad Request');
    }
    if (rel.includes('\0')) return textResponse(400, 'Bad Request');
    if (rel === '/' || rel === '') rel = o.index;
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel.replace(/\\/g, '/')));
    const inside = path.relative(root, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return textResponse(403, 'Forbidden');

    let stat = await fs.promises.stat(file).catch(() => null);
    if ((!stat || !stat.isFile()) && path.extname(rel) === '') {
      // Client-side routes fall back to the entry document.
      file = path.join(root, o.index);
      stat = await fs.promises.stat(file).catch(() => null);
    }
    if (!stat || !stat.isFile()) return textResponse(404, 'Not Found');

    const headers: Record<string, string> = {
      'Content-Type': contentTypeFor(file),
      'Content-Length': String(stat.size),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = o.csp;
    const body = req.method === 'HEAD' ? null : await fs.promises.readFile(file);
    return new Response(body, { status: 200, headers });
  };
}

/** Privileges to register before `app.ready` (protocol.registerSchemesAsPrivileged). */
export const privilegedSchemes = [
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
  {
    scheme: FILE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
];
