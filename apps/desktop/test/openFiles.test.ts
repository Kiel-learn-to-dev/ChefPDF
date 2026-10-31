import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpenFilesController, argvSkipCount, parseFileArgs } from '../src/main/openFiles';

const cwd = path.resolve('/work');
const existing = new Set([
  path.resolve('/work/a.pdf'),
  path.resolve('/docs/b.pdf'),
  path.resolve('/docs/Tài liệu c.pdf'),
]);
const isFile = (p: string) => existing.has(p);

describe('parseFileArgs', () => {
  it('skips the executable (packaged) and switches', () => {
    const argv = [
      '/opt/Chef PDF/chef-pdf',
      '--no-sandbox',
      '--allow-file-access-from-files',
      'a.pdf',
      '-x',
    ];
    expect(parseFileArgs(argv, { cwd, skip: 1, isFile })).toEqual([path.resolve('/work/a.pdf')]);
  });

  it('skips electron + app dir in dev', () => {
    const argv = ['electron', '.', path.resolve('/docs/b.pdf')];
    expect(parseFileArgs(argv, { cwd, skip: 2, isFile })).toEqual([path.resolve('/docs/b.pdf')]);
  });

  it('accepts file:// URLs, ignores missing files and de-duplicates', () => {
    const c = path.resolve('/docs/Tài liệu c.pdf');
    const argv = ['exe', pathToFileURL(c).href, c, 'missing.pdf', '/work/a.pdf', 'a.pdf'];
    expect(parseFileArgs(argv, { cwd, skip: 1, isFile })).toEqual([c, path.resolve('/work/a.pdf')]);
  });

  it('computes the skip count', () => {
    expect(argvSkipCount(true, false)).toBe(1);
    expect(argvSkipCount(false, true)).toBe(2);
    expect(argvSkipCount(false, false)).toBe(1);
  });
});

describe('OpenFilesController', () => {
  it('buffers files until attached, then delivers events; grants every file', () => {
    const granted: string[] = [];
    const c = new OpenFilesController((f) => granted.push(f));
    c.add(['/a.pdf', '/a.pdf', 'relative.pdf']);
    expect(c.initialFiles).toEqual(['/a.pdf']);
    const delivered: string[][] = [];
    c.attach((paths) => delivered.push(paths));
    c.add(['/b.pdf']);
    expect(delivered).toEqual([['/b.pdf']]);
    expect(c.initialFiles).toEqual(['/a.pdf']);
    c.detach();
    c.add(['/c.pdf']);
    expect(c.initialFiles).toEqual(['/a.pdf', '/c.pdf']);
    expect(granted).toEqual(['/a.pdf', '/a.pdf', '/b.pdf', '/c.pdf']);
  });
});
