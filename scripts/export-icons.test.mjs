// Kiểm thử script xuất icon (TASKS_RUST R1.14). Chạy: node --test scripts/export-icons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lucideImports, toKebab, iconToSvg, collectNames, ICON_DIR, UI_SRC } from './export-icons.mjs';
import { existsSync } from 'node:fs';

test('import nhiều dòng, alias và import type đều được đọc', () => {
  const src = `
    import {
      Check,
      CircleAlert as Warn,
      type LucideIcon,
      Columns2,
    } from 'lucide-react';
    import { Button } from './Button';
  `;
  assert.deepEqual(lucideImports(src).sort(), ['Check', 'CircleAlert', 'Columns2']);
});

test('tên PascalCase đổi đúng sang tên file kebab-case', () => {
  assert.equal(toKebab('CircleAlert'), 'circle-alert');
  assert.equal(toKebab('Columns2'), 'columns-2');
  assert.equal(toKebab('FileCheck2'), 'file-check-2');
  assert.equal(toKebab('X'), 'x');
  assert.equal(toKebab('CaseSensitive'), 'case-sensitive');
});

test('SVG có viewBox 24, nét currentColor và đúng số node', () => {
  const svg = iconToSvg({ node: [['path', { d: 'M1 1', key: 'k' }], ['path', { d: 'M2 2' }]] });
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.equal((svg.match(/<path /g) ?? []).length, 2);
  assert.doesNotMatch(svg, /key=/);
});

test('quét apps/ui tìm đủ 153 tên icon đã đếm', () => {
  assert.ok(existsSync(ICON_DIR), 'thiếu lucide-react, chạy pnpm install');
  assert.equal(collectNames(UI_SRC).length, 153);
});
