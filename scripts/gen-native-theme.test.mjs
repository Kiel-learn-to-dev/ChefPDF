// Kiểm thử bộ sinh theme (TASKS_RUST R1.11). Chạy: node --test scripts/gen-native-theme.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColor, resolveVars, generate, floatLit, SOURCE, OUTPUT } from './gen-native-theme.mjs';

test('màu hex, rgb và rgba đổi đúng sang 0–255', () => {
  assert.deepEqual(parseColor('#1d2330'), [0x1d, 0x23, 0x30, 255]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 255]);
  assert.deepEqual(parseColor('rgba(47, 107, 228, 0.45)'), [47, 107, 228, Math.round(0.45 * 255)]);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3, 255]);
  assert.equal(parseColor('cubic-bezier(0.2, 0, 0, 1)'), null);
});

test('var() được thay bằng giá trị trong cùng khối, kể cả lồng nhau', () => {
  const env = { a: '#112233', b: 'var(--a)', c: '0 0 0 2px var(--b)' };
  assert.equal(resolveVars(env.c, env), '0 0 0 2px #112233');
  assert.throws(() => resolveVars('var(--missing)', {}), /không có trong khối/);
});

test('số thực trong Rust luôn có dấu thập phân', () => {
  assert.equal(floatLit('11'), '11.0');
  assert.equal(floatLit('0.2'), '0.2');
  assert.equal(floatLit('-1'), '-1.0');
});

test('tokens.css hiện tại sinh đủ 126 khai báo', () => {
  const css = readFileSync(SOURCE, 'utf8');
  const { counts } = generate(css);
  assert.equal(counts.total, 126);
  assert.equal(counts.root + counts.dark, 126);
});

test('đổi một token làm đầu ra khác (phát hiện lệch cho --check)', () => {
  const css = readFileSync(SOURCE, 'utf8');
  const changed = css.replace('--c-accent: #2f6be4;', '--c-accent: #2f6be5;');
  assert.notEqual(generate(changed).text, generate(css).text);
});

test('file đã commit khớp đầu ra hiện tại', () => {
  const css = readFileSync(SOURCE, 'utf8');
  assert.equal(readFileSync(OUTPUT, 'utf8'), generate(css).text);
});
