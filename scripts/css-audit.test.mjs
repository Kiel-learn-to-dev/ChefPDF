/**
 * Unit test của scripts/css-audit.mjs (node:test, không cần thư viện thêm).
 * Chạy: node --test scripts/css-audit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditSources, extractVarCalls, parseDeclarations, splitTopLevel } from './css-audit.mjs';

const TOKENS = `:root { --space-3: 6px; --c-text: #111; --radius-sm: 5px; --font-sans: system-ui; }`;

function audit(css, { tsx = [], other = '' } = {}) {
  const file = 'apps/ui/src/x/test.css';
  return auditSources({
    tokensText: TOKENS,
    cssFiles: [{ file, text: css }, ...(other ? [{ file: 'o.css', text: other }] : [])],
    tsxTexts: tsx,
    targets: [{ file, text: css }],
  }).findings;
}

const kinds = (findings) => findings.map((f) => f.kind);

test('comments are ignored and keep line numbers', () => {
  const css = `/* padding: 5px;\n   gap: 7px; */\n.a { padding: 8px; }\n/* .b { margin: 3px } */`;
  assert.deepEqual(audit(css), []);
  const decls = parseDeclarations('/* x\ny */\n.a {\n  margin: 3px;\n}');
  assert.equal(decls[0].line, 4);
});

test('calc() values are not measured against the px scale', () => {
  const css = `.a { padding: calc(5px + 8px); height: calc(100% - 5px); gap: calc(3px * 2) 6px; }`;
  assert.deepEqual(audit(css), []);
  assert.deepEqual(splitTopLevel('calc(5px + 8px) 3px'), ['calc(5px + 8px)', '3px']);
});

test('@keyframes px values are skipped, but undefined vars there are still reported', () => {
  const css = `@keyframes pop { from { padding: 5px; transform: translateY(3px); }
    to { padding: 0; color: var(--nope); } }`;
  assert.deepEqual(kinds(audit(css)), ['var-undefined']);
});

test('shorthand with several values checks each value', () => {
  const css = `.a { padding: 4px 5px 0 12px; border-radius: 4px 3px 0 0; }`;
  const f = audit(css);
  assert.deepEqual(
    f.map((x) => [x.kind, x.token]),
    [
      ['spacing', '5px'],
      ['radius', '4px'],
    ],
  );
});

test('negative values are reported as negative and never as a positive token', () => {
  const css = `.a { margin: -4px 0; margin-left: -5px; }`;
  const f = audit(css);
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.kind === 'spacing' && x.negative === true));
});

test('1px, 0 and percentages are not spacing findings', () => {
  assert.deepEqual(audit(`.a { padding: 1px 0 50%; gap: 4px; }`), []);
});

test('undefined var is reported with its fallback; local and TSX names are accepted', () => {
  const css = `.b { --local: 3px; color: var(--c-nope, #000); }
    .c { color: var(--local); background: var(--kind-c); }`;
  const f = audit(css, { tsx: [`style={{ ['--kind-c' as string]: 'red' }}`] });
  assert.deepEqual(kinds(f), ['var-undefined']);
  assert.match(f[0].message, /var\(--c-nope\) không định nghĩa, fallback #000/);
});

test('fallback on a defined token: redundant when equal, mismatch when different', () => {
  const css = `.a { padding: var(--space-3, 6px); margin: var(--space-3, 10px); }`;
  assert.deepEqual(kinds(audit(css)), ['var-fallback-redundant', 'var-fallback-mismatch']);
  assert.deepEqual(extractVarCalls('var(--a, var(--b, 2px))'), [
    { name: '--a', fallback: 'var(--b, 2px)' },
    { name: '--b', fallback: '2px' },
  ]);
});

test('!important is reported and stripped from the value', () => {
  const f = audit(`.a { color: var(--c-text) !important; }`);
  assert.deepEqual(kinds(f), ['important']);
  assert.equal(f[0].value, 'var(--c-text)');
});

test('rem and off-scale font-size px are reported', () => {
  const css = `.a { font-size: 0.35rem; } .b { font-size: 12px; } .c { font-size: 13.5px; }`;
  const f = audit(css);
  assert.deepEqual(kinds(f), ['rem', 'font-size', 'font-size']);
  assert.equal(f[1].inScale, true);
  assert.equal(f[2].inScale, false);
  assert.match(f[0].message, /= 5.6px/);
});

test('radius and control height outside their scale are reported; 999px and 50% are not', () => {
  const css = `.a { border-radius: 9px 999px 50%; height: 28px; min-height: 26px; width: 17px; }`;
  assert.deepEqual(kinds(audit(css)), ['radius', 'height']);
});

test('custom property declarations are not measured, only their var() uses', () => {
  assert.deepEqual(audit(`:root2 { --thumb-w: 96px; }`), []);
});

test('a semicolon inside a quoted url() does not split the declaration', () => {
  const css = `.a { background: url("data:image/svg+xml;base64,AAAA"); padding: 5px; }`;
  const f = audit(css);
  assert.deepEqual(kinds(f), ['spacing']);
  assert.equal(f[0].prop, 'padding');
});

test('the tokens file itself is never reported as a target', () => {
  const r = auditSources({
    tokensText: TOKENS,
    cssFiles: [],
    tsxTexts: [],
    targets: [{ file: 'apps/ui/src/app/styles/tokens.css', text: `:root { --x: 7px; }` }],
  });
  assert.equal(r.summary.total, 0);
});

test('summary sorts files by total, then by name', () => {
  const r = auditSources({
    tokensText: TOKENS,
    cssFiles: [],
    tsxTexts: [],
    targets: [
      { file: 'b.css', text: `.a { padding: 5px; }` },
      { file: 'a.css', text: `.a { padding: 5px; } .b { gap: 7px; }` },
    ],
  });
  assert.deepEqual(
    r.summary.files.map((x) => [x.file, x.total]),
    [
      ['a.css', 2],
      ['b.css', 1],
    ],
  );
});
