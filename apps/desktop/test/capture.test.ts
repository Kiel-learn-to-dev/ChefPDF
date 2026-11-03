import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathAllowlist } from '../src/main/allowlist';
import type { ChefEvent } from '@chef/contracts';
import {
  CaptureError,
  CaptureService,
  chooseLanInterface,
  extensionForContentType,
  isPrivateLanIPv4,
  lanInterfaces,
  parseStartInput,
  qrSvgFor,
  sniffImage,
  tokenMatches,
  type CaptureDeps,
  type NetIface,
} from '../src/main/capture';

const LAN: NetIface = { name: 'Wi-Fi', address: '192.168.1.20', family: 'IPv4', internal: false };

describe('LAN address selection', () => {
  it('accepts only private IPv4 ranges', () => {
    expect(isPrivateLanIPv4('10.1.2.3')).toBe(true);
    expect(isPrivateLanIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateLanIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateLanIPv4('192.168.0.9')).toBe(true);
    expect(isPrivateLanIPv4('172.32.0.1')).toBe(false);
    expect(isPrivateLanIPv4('172.15.0.1')).toBe(false);
    expect(isPrivateLanIPv4('169.254.10.10')).toBe(false);
    expect(isPrivateLanIPv4('127.0.0.1')).toBe(false);
    expect(isPrivateLanIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateLanIPv4('300.1.1.1')).toBe(false);
    expect(isPrivateLanIPv4('fe80::1')).toBe(false);
  });

  it('drops internal, IPv6 and public addresses', () => {
    const list: NetIface[] = [
      { name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true },
      { name: 'v6', address: 'fd00::1', family: 'IPv6', internal: false },
      { name: 'vpn', address: '100.64.0.2', family: 'IPv4', internal: false },
      LAN,
    ];
    expect(lanInterfaces(list)).toEqual([{ name: 'Wi-Fi', address: '192.168.1.20' }]);
  });

  it('chooses the first LAN interface, or the one named', () => {
    const other: NetIface = { name: 'Ethernet', address: '10.0.0.5', family: 4, internal: false };
    expect(chooseLanInterface([LAN, other]).name).toBe('Wi-Fi');
    expect(chooseLanInterface([LAN, other], 'Ethernet').address).toBe('10.0.0.5');
  });

  it('reports NO_LAN_INTERFACE and INTERFACE_NOT_FOUND', () => {
    const lo: NetIface = { name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true };
    expect(() => chooseLanInterface([lo])).toThrow(CaptureError);
    try {
      chooseLanInterface([lo]);
    } catch (e) {
      expect((e as CaptureError).code).toBe('NO_LAN_INTERFACE');
    }
    try {
      chooseLanInterface([LAN], 'Nope');
    } catch (e) {
      expect((e as CaptureError).code).toBe('INTERFACE_NOT_FOUND');
    }
  });
});

describe('tokens and image checks', () => {
  const token = 'a'.repeat(32);

  it('compares tokens in constant time and rejects wrong length', () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches('b'.repeat(32), token)).toBe(false);
    expect(tokenMatches('a'.repeat(31), token)).toBe(false);
    expect(tokenMatches('a'.repeat(33), token)).toBe(false);
    expect(tokenMatches('', token)).toBe(false);
  });

  it('accepts only jpeg, png and webp content types', () => {
    expect(extensionForContentType('image/jpeg')).toBe('jpg');
    expect(extensionForContentType('IMAGE/PNG; charset=x')).toBe('png');
    expect(extensionForContentType('image/webp')).toBe('webp');
    expect(extensionForContentType('image/heic')).toBeNull();
    expect(extensionForContentType('text/html')).toBeNull();
    expect(extensionForContentType(undefined)).toBeNull();
  });

  it('sniffs magic bytes and rejects everything else', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1');
    expect(sniffImage(jpeg)).toBe('jpg');
    expect(sniffImage(png)).toBe('png');
    expect(sniffImage(webp)).toBe('webp');
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
    expect(sniffImage(Buffer.from('ftypheic', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('start input and QR', () => {
  it('applies defaults and refuses bad input', () => {
    expect(parseStartInput({ purpose: 'book' })).toEqual({
      purpose: 'book',
      maxPages: 200,
      interfaceName: undefined,
    });
    expect(() => parseStartInput({ purpose: 'other' })).toThrow();
    expect(() => parseStartInput({ purpose: 'book', maxPages: 0 })).toThrow();
    expect(() => parseStartInput({ purpose: 'book', maxPages: 501 })).toThrow();
    expect(() => parseStartInput({ purpose: 'book', maxPages: 2.5 })).toThrow();
    expect(() => parseStartInput({ purpose: 'book', extra: 1 })).toThrow();
    expect(() => parseStartInput(null)).toThrow();
  });

  it('renders the URL as an SVG with the URL in its title', () => {
    const url = 'http://192.168.1.20:5000/c/' + 'f'.repeat(32);
    const svg = qrSvgFor(url);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain(`<title>${url}</title>`);
  });
});

// --- Service tests: real HTTP server on 127.0.0.1, injected clock, timers and interfaces ---

interface Harness {
  service: CaptureService;
  root: string;
  events: ChefEvent[];
  timers: Array<{ fn: () => void; ms: number }>;
  setNow(ms: number): void;
}

const harnesses: Harness[] = [];
let sessionCounter = 0;

function harness(overrides: Partial<CaptureDeps> = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-capture-'));
  const events: ChefEvent[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let now = 1_700_000_000_000;
  const service = new CaptureService({
    interfaces: () => [LAN],
    bindHost: '127.0.0.1',
    captureRoot: root,
    pageHtml: async () => '<!doctype html><title>t</title>',
    newSessionId: () => `session-${++sessionCounter}`,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
    emit: (e) => events.push(e),
    log: () => undefined,
    ...overrides,
  });
  const h: Harness = {
    service,
    root,
    events,
    timers,
    setNow: (ms) => {
      now = ms;
    },
  };
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of harnesses.splice(0)) {
    await h.service.stop();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

const tokenOf = (url: string) => url.slice(url.indexOf('/c/') + 3);

const jpeg = (fill = 0) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, fill)]);
const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

async function upload(url: string, body: Buffer, opts: { type?: string; index?: number } = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': opts.type ?? 'image/jpeg',
      'X-Chef-Index': String(opts.index ?? 0),
    },
    body: new Uint8Array(body),
  });
}

describe('CaptureService', () => {
  it('starts on the LAN address (test override), returns URL, QR and interfaces', async () => {
    const h = harness();
    const r = await h.service.start({ purpose: 'book' });
    // The test override binds 127.0.0.1, and the URL uses the bound host.
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c\/[0-9a-f]{32}$/);
    expect(r.qrSvg.startsWith('<svg')).toBe(true);
    expect(r.interfaces).toEqual([{ name: 'Wi-Fi', address: '192.168.1.20' }]);
    expect(h.service.status()).toMatchObject({ state: 'active', count: 0 });
    expect(h.events[0]).toMatchObject({ type: 'capture-status', state: 'active' });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(10 * 60_000);
  });

  it('refuses to start without a LAN interface', async () => {
    const h = harness({ interfaces: () => [] });
    await expect(h.service.start({ purpose: 'book' })).rejects.toMatchObject({
      code: 'NO_LAN_INTERFACE',
    });
    expect(h.service.status().state).toBe('idle');
  });

  it('serves the page only with the right token, with a strict CSP', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    expect(ok.headers.get('set-cookie')).toBeNull();

    const base = url.slice(0, url.indexOf('/c/'));
    const token = tokenOf(url);
    for (const bad of [
      `${base}/c/${'b'.repeat(32)}`,
      `${base}/c/${token.slice(1)}`,
      `${base}/c/${token.toUpperCase()}`,
      `${base}/c/${token}?x=1`,
      `${base}/c/${token}/..%2F..%2Fsecret`,
      `${base}/c/${token}/`,
      `${base}/`,
    ]) {
      const r = await fetch(bad);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe('Not found');
    }
    const wrongMethod = await fetch(url, { method: 'POST', body: 'x' });
    expect(wrongMethod.status).toBe(404);
  });

  it('receives JPEG and PNG uploads, names files itself and emits events', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const up = url.replace('/c/', '/u/');

    const r1 = await upload(up, jpeg(1), { index: 0 });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ index: 0 });
    const r2 = await upload(up, png(), { type: 'image/png', index: 1 });
    expect(r2.status).toBe(200);

    const dir = path.join(h.root, 'session-' + sessionCounter);
    expect(fs.readdirSync(dir).sort()).toEqual(['001.jpg', '002.png']);
    expect(h.service.status()).toMatchObject({ state: 'active', count: 2 });
    const images = h.events.filter((e) => e.type === 'capture-image');
    expect(images).toEqual([
      { type: 'capture-image', index: 0, path: path.join(dir, '001.jpg') },
      { type: 'capture-image', index: 1, path: path.join(dir, '002.png') },
    ]);
  });

  it('makes a retried upload (same X-Chef-Index) idempotent', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const up = url.replace('/c/', '/u/');
    await upload(up, jpeg(1), { index: 7 });
    const again = await upload(up, jpeg(2), { index: 7 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ index: 0 });
    expect(h.service.status().count).toBe(1);
  });

  it('waits for the original write when concurrent requests retry the same client index', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const up = url.replace('/c/', '/u/');
    const [first, retry] = await Promise.all([
      upload(up, jpeg(1), { index: 12 }),
      upload(up, jpeg(2), { index: 12 }),
    ]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await first.json()).toEqual({ index: 0 });
    expect(await retry.json()).toEqual({ index: 0 });
    expect(fs.readdirSync(path.join(h.root, 'session-' + sessionCounter))).toEqual(['001.jpg']);
    expect(fs.readFileSync(path.join(h.root, 'session-' + sessionCounter, '001.jpg'))).toEqual(
      jpeg(1),
    );
    expect(h.events.filter((e) => e.type === 'capture-image')).toHaveLength(1);
  });

  it('serializes concurrent starts so only the newest server remains live', async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.service.start({ purpose: 'book' }),
      h.service.start({ purpose: 'signature' }),
    ]);
    const reachable = await Promise.allSettled([fetch(first.url), fetch(second.url)]);
    expect(reachable.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reachable[1]!.status).toBe('fulfilled');
    if (reachable[1]!.status === 'fulfilled') await reachable[1]!.value.body?.cancel();
    expect(h.service.status().state).toBe('active');
  });

  it('refuses wrong content types (415) and mismatched bytes (415)', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const up = url.replace('/c/', '/u/');
    expect((await upload(up, jpeg(), { type: 'image/gif' })).status).toBe(415);
    expect((await upload(up, jpeg(), { type: 'text/html' })).status).toBe(415);
    expect((await upload(up, Buffer.from('<script>'), { type: 'image/jpeg' })).status).toBe(415);
    expect((await upload(up, Buffer.from('ftypheic'), { type: 'image/heic' })).status).toBe(415);
    expect(h.service.status().count).toBe(0);
  });

  it('enforces maxPages and the body limit', async () => {
    const h = harness({ maxBodyBytes: 1000 });
    const { url } = await h.service.start({ purpose: 'signature', maxPages: 1 });
    const up = url.replace('/c/', '/u/');
    expect((await upload(up, jpeg(), { index: 0 })).status).toBe(200);
    expect((await upload(up, jpeg(), { index: 1 })).status).toBe(409);
    expect((await upload(up, jpeg(), { index: 1 })).status).toBe(409);

    const big = await upload(up, Buffer.concat([jpeg(), Buffer.alloc(2000)]), { index: 2 });
    expect(big.status).toBe(413);
    expect(h.service.status().count).toBe(1);
  });

  it.each(['timer', 'done'] as const)(
    'waits for an in-flight image before %s finish and a concurrent start',
    async (finishVia) => {
      const h = harness();
      const { url } = await h.service.start({ purpose: 'book' });
      const up = url.replace('/c/', '/u/');
      const originalWrite = fs.promises.writeFile.bind(fs.promises);
      let entered!: () => void;
      let release!: () => void;
      const writeEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const writeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(
        async (...args: Parameters<typeof fs.promises.writeFile>) => {
          entered();
          await writeGate;
          return originalWrite(...args);
        },
      );

      const uploadPromise = upload(up, jpeg(7), { index: 3 });
      await writeEntered;
      let donePromise: Promise<Response> | undefined;
      if (finishVia === 'timer') {
        h.timers[0]!.fn();
      } else {
        donePromise = fetch(up.replace('/u/', '/d/'), { method: 'POST' });
        // Let the server enqueue /done behind the held upload before start() is queued.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      let started = false;
      const nextStart = h.service.start({ purpose: 'book' }).then((result) => {
        started = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(started).toBe(false);
      release();
      const uploaded = await uploadPromise;
      expect(uploaded.status).toBe(200);
      if (donePromise) {
        const done = await donePromise;
        expect(done.status).toBe(200);
        expect(await done.json()).toEqual({ count: 1 });
      }
      const second = await nextStart;
      expect(
        fs.readFileSync(path.join(h.root, 'session-' + (sessionCounter - 1), '001.jpg')),
      ).toEqual(jpeg(7));
      expect(h.events).toContainEqual({
        type: 'capture-image',
        index: 0,
        path: path.join(h.root, 'session-' + (sessionCounter - 1), '001.jpg'),
      });
      expect((await fetch(second.url)).status).toBe(200);
    },
  );

  it('finishes queued uploads after stop instead of dropping images not yet writing', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const up = url.replace('/c/', '/u/');
    const originalWrite = fs.promises.writeFile.bind(fs.promises);
    let entered!: () => void;
    let release!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof fs.promises.writeFile>) => {
        entered();
        await writeGate;
        return originalWrite(...args);
      },
    );

    const first = upload(up, jpeg(1), { index: 0 });
    await writeEntered;
    const second = upload(up, jpeg(2), { index: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stopped = h.service.stop();
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();

    const [r1, r2] = await Promise.all([first, second]);
    await stopped;
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const dir = path.join(h.root, 'session-' + sessionCounter);
    expect(fs.readdirSync(dir).sort()).toEqual(['001.jpg', '002.jpg']);
    expect(fs.readFileSync(path.join(dir, '001.jpg'))).toEqual(jpeg(1));
    expect(fs.readFileSync(path.join(dir, '002.jpg'))).toEqual(jpeg(2));
    expect(h.events.filter((e) => e.type === 'capture-image')).toHaveLength(2);
    expect(h.events.at(-1)).toMatchObject({ type: 'capture-status', state: 'stopped', count: 2 });
  });

  it('returns limit errors for concurrent retries of an upload beyond maxPages', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book', maxPages: 1 });
    const up = url.replace('/c/', '/u/');
    expect((await upload(up, jpeg(1), { index: 0 })).status).toBe(200);
    const retries = await Promise.all([
      upload(up, jpeg(2), { index: 9 }),
      upload(up, jpeg(3), { index: 9 }),
    ]);
    expect(retries.map((r) => r.status)).toEqual([409, 409]);
    expect(await Promise.all(retries.map((r) => r.json()))).toEqual([
      { error: 'limit' },
      { error: 'limit' },
    ]);
    expect(h.service.status().count).toBe(1);
  });

  it('rate-limits to 5 requests per second per session', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await fetch(url)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    // The window uses the injected clock: one second later the quota is back.
    h.setNow(h.service.status().expiresAt! - 10 * 60_000 + 1000);
    expect((await fetch(url)).status).toBe(200);
  });

  it('finishes on "done" and closes the server', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const up = url.replace('/c/', '/u/');
    await upload(up, jpeg(), { index: 0 });
    const done = await fetch(up.replace('/u/', '/d/'), { method: 'POST' });
    expect(await done.json()).toEqual({ count: 1 });
    await waitFor(() => statusEvents(h).includes('done'));
    expect(h.events.at(-1)).toMatchObject({ type: 'capture-status', state: 'done', count: 1 });
    await expect(fetch(url)).rejects.toThrow();
  });

  it('expires after 10 minutes (injected timer) and closes the server', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    expect(h.timers).toHaveLength(1);
    h.timers[0]!.fn();
    await waitFor(() => statusEvents(h).includes('expired'));
    expect(h.events.at(-1)).toMatchObject({ type: 'capture-status', state: 'expired' });
    await expect(fetch(url)).rejects.toThrow();
  });

  it('stop() closes the server, sockets and timer, and is safe to repeat', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    expect((await fetch(url)).status).toBe(200); // leaves a keep-alive socket behind
    await h.service.stop();
    await h.service.stop();
    expect(h.timers).toHaveLength(0);
    expect(h.service.status()).toEqual({ state: 'idle', count: 0 });
    await expect(fetch(url)).rejects.toThrow();
    expect(
      h.events
        .filter((e) => e.type === 'capture-status')
        .map((e) => (e as { state: string }).state),
    ).toEqual(['active', 'stopped']);
  });

  it('keeps only one session: a new start stops the previous server', async () => {
    const h = harness();
    const first = await h.service.start({ purpose: 'book' });
    const second = await h.service.start({ purpose: 'signature' });
    expect(second.url).not.toBe(first.url);
    await expect(fetch(first.url)).rejects.toThrow();
    expect((await fetch(second.url)).status).toBe(200);
    expect(h.service.status().state).toBe('active');
  });

  it('does not let a stale session stop a newer capture session', async () => {
    const h = harness();
    const oldSession = await h.service.start({ purpose: 'book' });
    const newSession = await h.service.start({ purpose: 'signature' });
    await h.service.stop(oldSession.sessionId);

    expect(h.service.status().state).toBe('active');
    expect((await fetch(newSession.url)).status).toBe(200);
    await h.service.stop(newSession.sessionId);
    await expect(fetch(newSession.url)).rejects.toThrow();
  });

  it('refuses path traversal and bad upload indexes', async () => {
    const h = harness();
    const { url } = await h.service.start({ purpose: 'book' });
    const token = tokenOf(url);
    const base = url.slice(0, url.indexOf('/c/'));
    const traversal = await fetch(`${base}/u/${token}/../../etc`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Chef-Index': '0' },
      body: jpeg(),
    });
    expect(traversal.status).toBe(404);
    const noIndex = await fetch(`${base}/u/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpeg(),
    });
    expect(noIndex.status).toBe(400);
    const okUpload = await upload(`${base}/u/${token}`, jpeg(), { index: 0 });
    expect(okUpload.status).toBe(200);
    // Only server-made names exist in the session folder.
    expect(fs.readdirSync(path.join(h.root, 'session-' + sessionCounter))).toEqual(['001.jpg']);
  });

  it('removes capture folders left by earlier sessions on start', async () => {
    const h = harness();
    const stale = path.join(h.root, 'old-session');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, '001.jpg'), 'x');
    await h.service.start({ purpose: 'book' });
    expect(fs.existsSync(stale)).toBe(false);
  });
});

/** States of the capture-status events emitted so far, in order. */
function statusEvents(h: Harness): string[] {
  return h.events
    .filter((e): e is Extract<ChefEvent, { type: 'capture-status' }> => e.type === 'capture-status')
    .map((e) => e.state);
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('chef-file access to captured photos', () => {
  // index.ts allows userData/cache (which holds cache/capture) and the photo paths come from
  // capture-image events. Here: a capture folder is readable, its siblings are not.
  const root = '/data/cache/capture';
  const list = new PathAllowlist([root], { platform: 'linux', realpath: (p) => p });

  it('allows the photos of a capture session', () => {
    expect(list.isAllowed(`${root}/session-1/001.jpg`)).toBe(true);
    expect(list.isAllowed(`${root}/session-1/002.png`)).toBe(true);
  });

  it('refuses the capture root itself, other cache folders and traversal', () => {
    expect(list.isAllowed(root)).toBe(false);
    expect(list.isAllowed('/data/cache/clipboard/001.png')).toBe(false);
    expect(list.isAllowed(`${root}/../sigwork/x.png`)).toBe(false);
  });
});
