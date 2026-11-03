/**
 * Phone capture (L5 / T8.11, also I19 signatures): a temporary HTTP server in the main process,
 * alive only while a capture session runs.
 *
 * Rules (the renderer and the phone cannot bypass them):
 *  - bound to ONE private IPv4 LAN address (10/8, 172.16/12, 192.168/16), random port;
 *  - every route needs the one-time token in the path; wrong tokens get a bare 404;
 *  - uploads: image/jpeg, image/png or image/webp only, magic bytes must match, body <= 25 MB,
 *    at most maxPages files;
 *  - at most 5 requests per second per session; no CORS, no cookies, no-store caching;
 *  - files are named by the server (NNN.ext) inside userData/cache/capture/<session>/;
 *  - the session ends on stop(), on "done", after 10 minutes, or on app quit; the server and its
 *    sockets are closed every time.
 * The token is returned only inside `url` and is never logged.
 *
 * Every dependency (network interfaces, clock, timers, fs, emitter) is injected for tests.
 *
 * NOTE: the mobile page (static/capture.html) has been tested in a desktop browser only,
 * not on a real phone.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import qrcode from 'qrcode-generator';
import type {
  CaptureState,
  CaptureStartResult,
  CaptureStatus,
  ChefEvent,
  LanInterface,
} from '@chef/contracts';

export const CAPTURE_TIMEOUT_MS = 10 * 60_000;
export const CAPTURE_MAX_BODY_BYTES = 25 * 1024 * 1024;
export const CAPTURE_DEFAULT_MAX_PAGES = 200;
export const CAPTURE_MAX_PAGES = 500;
export const CAPTURE_RATE_PER_SECOND = 5;
const TOKEN_HEX_LENGTH = 32; // 128 bits

/** CSP of the mobile page (served by GET /c/<token>). */
export const CAPTURE_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'";

export type CaptureErrorCode = 'NO_LAN_INTERFACE' | 'INTERFACE_NOT_FOUND' | 'INVALID_REQUEST';

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

/** One address of the machine, as `os.networkInterfaces()` reports it (flattened). */
export interface NetIface {
  name: string;
  address: string;
  family: string | number;
  internal: boolean;
}

export interface ParsedCaptureStart {
  purpose: 'book' | 'signature';
  maxPages: number;
  interfaceName?: string;
}

export function isPrivateLanIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return false;
  if (m.slice(1).some((o) => Number(o) > 255)) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/** Private IPv4 addresses of non-internal interfaces (link-local 169.254/16 is excluded). */
export function lanInterfaces(list: NetIface[]): LanInterface[] {
  const isV4 = (f: string | number) => f === 'IPv4' || f === 4;
  return list
    .filter((i) => !i.internal && isV4(i.family) && isPrivateLanIPv4(i.address))
    .map((i) => ({ name: i.name, address: i.address }));
}

/** The interface to bind: the first LAN one, or the one named `name`. */
export function chooseLanInterface(list: NetIface[], name?: string): LanInterface {
  const lan = lanInterfaces(list);
  if (lan.length === 0) throw new CaptureError('NO_LAN_INTERFACE', 'no LAN interface');
  if (name === undefined) return lan[0]!;
  const found = lan.find((i) => i.name === name);
  if (!found) throw new CaptureError('INTERFACE_NOT_FOUND', 'interface not found');
  return found;
}

export function newToken(): string {
  return randomBytes(TOKEN_HEX_LENGTH / 2).toString('hex');
}

/** Constant-time comparison of a token from the URL with the session token. */
export function tokenMatches(given: string, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}

export type ImageExt = 'jpg' | 'png' | 'webp';

/** Extension for an accepted upload Content-Type (parameters ignored), or null. */
export function extensionForContentType(contentType: string | undefined): ImageExt | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (base === 'image/jpeg') return 'jpg';
  if (base === 'image/png') return 'png';
  if (base === 'image/webp') return 'webp';
  return null;
}

/** Image format from the magic bytes (JPEG, PNG, WebP), or null. HEIC is not accepted. */
export function sniffImage(bytes: Uint8Array): ImageExt | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'png';
  const ascii = (from: number, text: string) =>
    [...text].every((c, i) => bytes[from + i] === c.charCodeAt(0));
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  return null;
}

/** Validates the renderer's start request. Unknown keys are refused. */
export function parseStartInput(input: unknown): ParsedCaptureStart {
  if (typeof input !== 'object' || input === null) throw bad('input must be an object');
  const v = input as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (!['purpose', 'maxPages', 'interfaceName'].includes(k)) throw bad(`unknown option ${k}`);
  }
  if (v.purpose !== 'book' && v.purpose !== 'signature') {
    throw bad('purpose must be book or signature');
  }
  const maxPages = v.maxPages ?? CAPTURE_DEFAULT_MAX_PAGES;
  if (
    typeof maxPages !== 'number' ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > CAPTURE_MAX_PAGES
  ) {
    throw bad(`maxPages must be an integer from 1 to ${CAPTURE_MAX_PAGES}`);
  }
  let interfaceName: string | undefined;
  if (v.interfaceName !== undefined) {
    if (typeof v.interfaceName !== 'string' || v.interfaceName.length > 128) {
      throw bad('interfaceName must be a short string');
    }
    interfaceName = v.interfaceName;
  }
  return { purpose: v.purpose, maxPages, interfaceName };
}

/** QR code of `text` as an SVG string (error correction M). */
export function qrSvgFor(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  if (!svg.startsWith('<svg')) throw new Error('QR generation failed');
  // The text is also the SVG <title> (screen readers, and a way to check the payload).
  const title = `<title>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</title>`;
  return svg.replace(/>/, `>${title}`);
}

export interface CaptureDeps {
  /** Network interfaces of the machine (os.networkInterfaces, flattened). */
  interfaces(): NetIface[];
  /** Overrides the bind (and URL) host. Only for tests and the E2E hook. */
  bindHost?: string;
  /** userData/cache/capture */
  captureRoot: string;
  /** HTML of the mobile page. */
  pageHtml(): Promise<string>;
  newSessionId(): string;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  emit(event: ChefEvent): void;
  log(message: string): void;
  maxBodyBytes?: number;
}

interface ActiveSession {
  id: string;
  token: string;
  dir: string;
  maxPages: number;
  state: CaptureState;
  expiresAt: number;
  server: http.Server;
  sockets: Set<Socket>;
  timer: unknown;
  /** Request timestamps (ms) inside the last second. */
  recent: number[];
  /** Files in receive order: index is the 0-based ordinal the server assigned. */
  images: Array<{ index: number; path: string }>;
  /** Client index (X-Chef-Index) to completed or in-flight upload. */
  byClientIndex: Map<number, Promise<number | null>>;
  pendingWrites: Set<Promise<void>>;
  writeQueue: Promise<void>;
}

function pad3(n: number): string {
  return String(n + 1).padStart(3, '0');
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string,
  type = 'application/json; charset=utf-8',
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

/** Bare 404 for everything that is not a valid route with the right token. */
function notFound(res: http.ServerResponse): void {
  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
}

/** Routes: /c/<token> (page), /u/<token> (upload), /d/<token> (done). No query strings. */
const ROUTE = /^\/(c|u|d)\/([0-9a-f]{32})$/;

export class CaptureService {
  private session: ActiveSession | null = null;
  private readonly maxBodyBytes: number;
  private lifecycle: Promise<void> = Promise.resolve();
  private sweptStaleFolders = false;

  constructor(private readonly deps: CaptureDeps) {
    this.maxBodyBytes = deps.maxBodyBytes ?? CAPTURE_MAX_BODY_BYTES;
  }

  /** Starts a session. A running one is stopped first: at most one session at a time. */
  start(input: unknown): Promise<CaptureStartResult> {
    return this.serializeLifecycle(() => this.startSession(input));
  }

  private async startSession(input: unknown): Promise<CaptureStartResult> {
    const opts = parseStartInput(input);
    if (this.session) await this.finishNow(this.session, 'stopped');

    const iface = chooseLanInterface(this.deps.interfaces(), opts.interfaceName);
    const host = this.deps.bindHost ?? iface.address;
    await this.sweepStale();

    const id = this.deps.newSessionId();
    const dir = path.join(this.deps.captureRoot, id);
    await fsp.mkdir(dir, { recursive: true });

    const token = newToken();
    const sockets = new Set<Socket>();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) send(res, 500, 'error', 'text/plain; charset=utf-8');
        else res.destroy();
      });
    });
    server.on('connection', (s: Socket) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;

    const expiresAt = this.deps.now() + CAPTURE_TIMEOUT_MS;
    const session: ActiveSession = {
      id,
      token,
      dir,
      maxPages: opts.maxPages,
      state: 'active',
      expiresAt,
      server,
      sockets,
      timer: null,
      recent: [],
      images: [],
      byClientIndex: new Map(),
      pendingWrites: new Set(),
      writeQueue: Promise.resolve(),
    };
    session.timer = this.deps.setTimer(() => {
      void this.serializeLifecycle(() => this.finishNow(session, 'expired'));
    }, CAPTURE_TIMEOUT_MS);
    this.session = session;

    const url = `http://${host}:${port}/c/${token}`;
    const qrSvg = qrSvgFor(url);
    this.deps.log(`capture started on ${iface.name}`);
    this.deps.emit({ type: 'capture-status', state: 'active', count: 0, expiresAt });
    return {
      sessionId: id,
      url,
      qrSvg,
      expiresAt,
      interfaces: lanInterfaces(this.deps.interfaces()),
    };
  }

  /** Stops the running session (no-op when idle). Received files stay on disk for the caller. */
  stop(sessionId?: string): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.session && (sessionId === undefined || this.session.id === sessionId)) {
        await this.finishNow(this.session, 'stopped');
      }
    });
  }

  private serializeLifecycle<T>(action: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(action);
    this.lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  status(): CaptureStatus {
    const s = this.session;
    if (!s) return { state: 'idle', count: 0 };
    return { state: s.state, count: s.images.length, expiresAt: s.expiresAt };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const s = this.session;
    const m = ROUTE.exec(req.url ?? '');
    if (!s || !m || !tokenMatches(m[2]!, s.token)) return notFound(res);

    const kind = m[1];
    if (req.method !== (kind === 'c' ? 'GET' : 'POST')) return notFound(res);

    const now = this.deps.now();
    s.recent = s.recent.filter((t) => now - t < 1000);
    if (s.recent.length >= CAPTURE_RATE_PER_SECOND) {
      res.setHeader('Retry-After', '1');
      return send(res, 429, JSON.stringify({ error: 'rate' }));
    }
    s.recent.push(now);

    if (kind === 'c') {
      const html = await this.deps.pageHtml();
      res.setHeader('Content-Security-Policy', CAPTURE_PAGE_CSP);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (kind === 'd') {
      await this.serializeLifecycle(async () => {
        await s.writeQueue;
        if (this.session !== s) return notFound(res);
        send(res, 200, JSON.stringify({ count: s.images.length }));
        await new Promise<void>((resolve) => {
          res.once('finish', resolve);
          res.once('close', resolve);
        });
        await this.finishNow(s, 'done');
      });
      return;
    }
    await this.receive(req, res, s);
  }

  private async receive(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    s: ActiveSession,
  ): Promise<void> {
    const ext = extensionForContentType(req.headers['content-type']);
    if (!ext) {
      req.resume();
      return send(res, 415, JSON.stringify({ error: 'type' }));
    }
    const header = req.headers['x-chef-index'];
    const clientIndex =
      typeof header === 'string' && /^\d{1,4}$/.test(header) ? Number(header) : -1;
    if (clientIndex < 0) {
      req.resume();
      return send(res, 400, JSON.stringify({ error: 'index' }));
    }
    if (Number(req.headers['content-length'] ?? '0') > this.maxBodyBytes) {
      req.resume();
      res.setHeader('Connection', 'close');
      return send(res, 413, JSON.stringify({ error: 'size' }));
    }

    const body = await readBody(req, this.maxBodyBytes);
    if (!body) {
      res.setHeader('Connection', 'close');
      return send(res, 413, JSON.stringify({ error: 'size' }));
    }
    if (s.state !== 'active') return notFound(res);
    const known = s.byClientIndex.get(clientIndex);
    if (known) {
      const index = await known;
      if (index === null) return send(res, 500, JSON.stringify({ error: 'write' }));
      if (index === -1) return send(res, 409, JSON.stringify({ error: 'limit' }));
      if (index === -2) return send(res, 400, JSON.stringify({ error: 'path' }));
      return send(res, 200, JSON.stringify({ index }));
    }
    if (sniffImage(body) !== ext) return send(res, 415, JSON.stringify({ error: 'content' }));
    let resolveUpload!: (value: number | null) => void;
    const uploadResult = new Promise<number | null>((resolve) => {
      resolveUpload = resolve;
    });
    s.byClientIndex.set(clientIndex, uploadResult);
    const responseDone = new Promise<void>((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
    });
    s.pendingWrites.add(responseDone);
    void responseDone.finally(() => s.pendingWrites.delete(responseDone));
    const write = s.writeQueue.then(async () => {
      if (s.images.length >= s.maxPages) {
        s.byClientIndex.delete(clientIndex);
        resolveUpload(-1);
        return;
      }
      const index = s.images.length;
      const target = path.resolve(s.dir, `${pad3(index)}.${ext}`);
      if (path.dirname(target) !== path.resolve(s.dir)) {
        s.byClientIndex.delete(clientIndex);
        resolveUpload(-2);
        return;
      }
      const entry = { index, path: target };
      try {
        await fsp.writeFile(target, body, { flag: 'wx' });
        s.images.push(entry);
        resolveUpload(index);
        this.deps.emit({ type: 'capture-image', index, path: target });
      } catch {
        s.byClientIndex.delete(clientIndex);
        resolveUpload(null);
      }
    });
    s.writeQueue = write.catch(() => undefined);
    s.pendingWrites.add(write);
    void write.finally(() => s.pendingWrites.delete(write));
    const result = await uploadResult;
    if (result === -1) return send(res, 409, JSON.stringify({ error: 'limit' }));
    if (result === -2) return send(res, 400, JSON.stringify({ error: 'path' }));
    if (result === null) return send(res, 500, JSON.stringify({ error: 'write' }));
    send(res, 200, JSON.stringify({ index: result }));
  }

  private async finishNow(s: ActiveSession, state: CaptureState): Promise<void> {
    if (this.session !== s) return;
    this.session = null;
    s.state = state;
    this.deps.clearTimer(s.timer);
    const serverClosed = new Promise<void>((resolve) => s.server.close(() => resolve()));
    await Promise.all([...s.pendingWrites]);
    for (const socket of s.sockets) socket.destroy();
    s.sockets.clear();
    s.server.closeAllConnections?.();
    await serverClosed;
    this.deps.log(`capture ${state}`);
    this.deps.emit({
      type: 'capture-status',
      state,
      count: s.images.length,
      expiresAt: s.expiresAt,
    });
  }

  /** Removes capture folders left by earlier sessions (never the running one). */
  private async sweepStale(): Promise<void> {
    if (this.sweptStaleFolders) return;
    const entries = await fsp.readdir(this.deps.captureRoot).catch(() => [] as string[]);
    for (const e of entries) {
      await fsp
        .rm(path.join(this.deps.captureRoot, e), { recursive: true, force: true })
        .catch(() => undefined);
    }
    this.sweptStaleFolders = true;
  }
}

/** Reads the request body; resolves null when it exceeds `limit` bytes. */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function bad(message: string): CaptureError {
  return new CaptureError('INVALID_REQUEST', message);
}
