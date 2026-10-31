import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PathAllowlist } from '../src/main/allowlist';
import { buildCsp } from '../src/main/csp';
import {
  contentTypeFor,
  createAppHandler,
  createFileHandler,
  parseRange,
  pathFromFileUrl,
} from '../src/main/protocol';
import { fileUrl } from '../src/shared/ipc';

describe('pathFromFileUrl', () => {
  it('decodes chef-file URLs produced by files.toUrl', () => {
    expect(pathFromFileUrl(fileUrl('/home/u/Tài liệu/a b.pdf'), 'linux')).toBe(
      '/home/u/Tài liệu/a b.pdf',
    );
    expect(pathFromFileUrl(fileUrl('C:\\Users\\me\\x.pdf'), 'win32')).toBe('C:\\Users\\me\\x.pdf');
  });

  it('rejects other hosts, schemes, relative paths and bad encodings', () => {
    expect(pathFromFileUrl('chef-file://g/%2Fetc%2Fpasswd', 'linux')).toBeNull();
    expect(pathFromFileUrl('file:///etc/passwd', 'linux')).toBeNull();
    expect(pathFromFileUrl('chef-file://f/relative.pdf', 'linux')).toBeNull();
    expect(pathFromFileUrl('chef-file://f/%E0%A4%A', 'linux')).toBeNull();
    expect(pathFromFileUrl('chef-file://f/%2Fa%00b', 'linux')).toBeNull();
  });
});

describe('parseRange', () => {
  it('parses single byte ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });

  it('ignores absent/multi ranges and flags unsatisfiable ones', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

describe('contentTypeFor', () => {
  it('maps common types', () => {
    expect(contentTypeFor('/x/A.PDF')).toBe('application/pdf');
    expect(contentTypeFor('/x/a.png')).toBe('image/png');
    expect(contentTypeFor('/x/a.wasm')).toBe('application/wasm');
    expect(contentTypeFor('/x/a.unknown')).toBe('application/octet-stream');
  });
});

describe('chef-file handler', () => {
  let base: string;
  let pdf: string;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chef-proto-')));
    const sessions = path.join(base, 'sessions');
    fs.mkdirSync(path.join(sessions, 's1'), { recursive: true });
    pdf = path.join(sessions, 's1', 'rev-0000.pdf');
    fs.writeFileSync(pdf, Buffer.from('%PDF-1.7\n0123456789'));
    fs.writeFileSync(path.join(base, 'settings.json'), '{}');
    handler = createFileHandler(new PathAllowlist([sessions, path.join(base, 'cache')]));
  });

  it('serves allowed files with content type and length', async () => {
    const res = await handler(new Request(fileUrl(pdf)));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe('19');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toBe('%PDF-1.7\n0123456789');
  });

  it('supports byte ranges', async () => {
    const res = await handler(new Request(fileUrl(pdf), { headers: { Range: 'bytes=9-12' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 9-12/19');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('0123');
    const bad = await handler(new Request(fileUrl(pdf), { headers: { Range: 'bytes=50-' } }));
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */19');
  });

  it('answers HEAD without a body and OPTIONS preflight', async () => {
    const head = await handler(new Request(fileUrl(pdf), { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('19');
    expect(await head.text()).toBe('');
    const opt = await handler(new Request(fileUrl(pdf), { method: 'OPTIONS' }));
    expect(opt.status).toBe(204);
  });

  it('returns 403 outside the allowlist (including traversal) and 404 for missing files', async () => {
    expect((await handler(new Request(fileUrl(path.join(base, 'settings.json'))))).status).toBe(
      403,
    );
    expect((await handler(new Request(fileUrl(`${base}/sessions/../settings.json`)))).status).toBe(
      403,
    );
    expect((await handler(new Request(fileUrl('/etc/passwd')))).status).toBe(403);
    expect(
      (await handler(new Request(fileUrl(path.join(base, 'sessions', 's1', 'nope.pdf'))))).status,
    ).toBe(403);
    expect((await handler(new Request('chef-file://f/relative'))).status).toBe(400);
    expect((await handler(new Request(fileUrl(pdf), { method: 'POST', body: 'x' }))).status).toBe(
      405,
    );
  });
});

describe('chef-app handler', () => {
  let root: string;
  const csp = buildCsp();
  let handler: (req: Request) => Promise<Response>;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chef-ui-'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>UI</title>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'nope');
    handler = createAppHandler({ root, index: 'index.html', csp });
  });

  it('serves the index with a CSP header', async () => {
    const res = await handler(new Request('chef-app://ui/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toBe(csp);
  });

  it('serves assets with the right MIME type', async () => {
    const res = await handler(new Request('chef-app://ui/assets/app.js'));
    expect(res.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(await res.text()).toBe('console.log(1)');
  });

  it('falls back to the index for client routes and 404s missing assets', async () => {
    expect((await handler(new Request('chef-app://ui/settings/general'))).status).toBe(200);
    expect((await handler(new Request('chef-app://ui/assets/missing.js'))).status).toBe(404);
  });

  it('never escapes the root', async () => {
    const res = await handler(new Request('chef-app://ui/%2E%2E/outside.txt'));
    expect(res.status).not.toBe(200);
    const res2 = await handler(new Request('chef-app://ui/..%2Foutside.txt'));
    expect(await res2.text()).not.toBe('nope');
  });
});

describe('buildCsp', () => {
  it('is strict in production', () => {
    const csp = buildCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("img-src 'self' chef-file: blob: data:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/https?:/);
  });

  it('allows the dev server and its websocket in dev', () => {
    const csp = buildCsp({ devServerUrl: 'http://localhost:5173' });
    expect(csp).toContain('ws://localhost:5173');
    expect(csp).toContain('http://localhost:5173');
  });
});
