import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathAllowlist } from '../src/main/allowlist';

const identity = (p: string) => p;

describe('PathAllowlist (lexical, posix)', () => {
  const list = new PathAllowlist(['/data/sessions', '/data/cache'], {
    platform: 'linux',
    realpath: identity,
  });

  it('allows files inside the roots', () => {
    expect(list.isAllowed('/data/sessions/abc/rev-0000.pdf')).toBe(true);
    expect(list.isAllowed('/data/cache/thumb.png')).toBe(true);
  });

  it('rejects the roots themselves, siblings with a common prefix and traversal', () => {
    expect(list.isAllowed('/data/sessions')).toBe(false);
    expect(list.isAllowed('/data/sessions-evil/x.pdf')).toBe(false);
    expect(list.isAllowed('/data/sessions/../settings.json')).toBe(false);
    expect(list.isAllowed('/data/sessions/a/../../../etc/passwd')).toBe(false);
    expect(list.isAllowed('/etc/passwd')).toBe(false);
  });

  it('rejects relative paths and NUL bytes', () => {
    expect(list.isAllowed('data/sessions/x.pdf')).toBe(false);
    expect(list.isAllowed('/data/sessions/x\0.pdf')).toBe(false);
  });

  it('allows explicitly granted files only', () => {
    const l = new PathAllowlist([], { platform: 'linux', realpath: identity });
    l.addFile('/home/u/Docs/a.pdf');
    expect(l.isAllowed('/home/u/Docs/a.pdf')).toBe(true);
    expect(l.isAllowed('/home/u/Docs/./a.pdf')).toBe(true);
    expect(l.isAllowed('/home/u/Docs/b.pdf')).toBe(false);
    expect(l.isAllowed('/home/u/Docs/A.pdf')).toBe(false);
    l.addFile('relative.pdf');
    expect(l.isAllowed(path.resolve('relative.pdf'))).toBe(false);
  });
});

describe('PathAllowlist (scan previews)', () => {
  // scan.preview writes PNGs to <sessions>/<sessionId>/preview/, inside the sessions root.
  const sessions = '/data/sessions';
  const list = new PathAllowlist([sessions], { platform: 'linux', realpath: identity });

  it('allows the preview images of a session', () => {
    expect(list.isAllowed('/data/sessions/s1/preview/abcd1234-p0-original.png')).toBe(true);
    expect(list.isAllowed('/data/sessions/s1/preview/abcd1234-p0-result.png')).toBe(true);
  });

  it('does not allow previews escaping their session', () => {
    expect(list.isAllowed('/data/sessions/s1/preview/../../../settings.json')).toBe(false);
    expect(list.isAllowed('/data/sessions/s1/preview/../../../etc/x.png')).toBe(false);
  });
});

describe('PathAllowlist (win32)', () => {
  it('compares case-insensitively', () => {
    const l = new PathAllowlist(['C:\\Users\\me\\AppData\\Roaming\\Chef PDF\\sessions'], {
      platform: 'win32',
      realpath: identity,
    });
    expect(
      l.isAllowed('c:\\users\\ME\\appdata\\roaming\\chef pdf\\sessions\\s1\\rev-0001.pdf'),
    ).toBe(true);
    expect(l.isAllowed('C:\\Users\\me\\AppData\\Roaming\\Chef PDF\\settings.json')).toBe(false);
    l.addFile('D:\\Docs\\Report.PDF');
    expect(l.isAllowed('d:\\docs\\report.pdf')).toBe(true);
  });
});

describe('PathAllowlist (real filesystem)', () => {
  it.skipIf(process.platform === 'win32')(
    'blocks symlinks that escape an allowed root and missing files',
    () => {
      const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chef-allow-')));
      const sessions = path.join(base, 'sessions');
      fs.mkdirSync(sessions);
      fs.writeFileSync(path.join(sessions, 'ok.pdf'), 'x');
      fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
      fs.symlinkSync(path.join(base, 'secret.txt'), path.join(sessions, 'link.pdf'));

      const l = new PathAllowlist([sessions]);
      expect(l.isAllowed(path.join(sessions, 'ok.pdf'))).toBe(true);
      expect(l.isAllowed(path.join(sessions, 'link.pdf'))).toBe(false);
      expect(l.isAllowed(path.join(sessions, 'missing.pdf'))).toBe(false);

      // A granted symlink also grants its target.
      const outside = path.join(base, 'doc-link.pdf');
      fs.symlinkSync(path.join(sessions, 'ok.pdf'), outside);
      l.addFile(outside);
      expect(l.isAllowed(outside)).toBe(true);
    },
  );
});
