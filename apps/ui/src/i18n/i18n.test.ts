import { describe, expect, it } from 'vitest';
import vi from './vi.json';
import en from './en.json';

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : flatten(v, `${prefix}${k}.`),
  );
}

const strip = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '');

const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('i18n resources', () => {
  const viKeys = new Set(flatten(vi as Tree).map(strip));
  const enKeys = new Set(flatten(en as Tree).map(strip));

  it('vi and en have the same keys', () => {
    expect([...viKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys].filter((k) => !viKeys.has(k))).toEqual([]);
  });

  it('every literal t() key used in the code exists', () => {
    const missing: string[] = [];
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        if (!viKeys.has(m[1]!)) missing.push(`${m[1]} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
