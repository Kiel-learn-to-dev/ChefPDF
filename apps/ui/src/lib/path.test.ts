import { describe, expect, it } from 'vitest';
import { basename, dirname, join, stripExt, withSuffix } from './path';

describe('path helpers', () => {
  it('posix', () => {
    expect(basename('/home/a/hop dong.pdf')).toBe('hop dong.pdf');
    expect(dirname('/home/a/b.pdf')).toBe('/home/a');
    expect(dirname('/b.pdf')).toBe('/');
    expect(join('/home/a', 'x.pdf')).toBe('/home/a/x.pdf');
    expect(withSuffix('/home/a/b.pdf', '_1')).toBe('/home/a/b_1.pdf');
  });

  it('windows', () => {
    expect(basename('C:\\Users\\a\\b.pdf')).toBe('b.pdf');
    expect(dirname('C:\\Users\\a\\b.pdf')).toBe('C:\\Users\\a');
    expect(dirname('C:\\b.pdf')).toBe('C:\\');
    expect(join('C:\\Users', 'x.pdf')).toBe('C:\\Users\\x.pdf');
  });

  it('strips extension', () => {
    expect(stripExt('a.b.pdf')).toBe('a.b');
    expect(stripExt('.hidden')).toBe('.hidden');
  });
});
