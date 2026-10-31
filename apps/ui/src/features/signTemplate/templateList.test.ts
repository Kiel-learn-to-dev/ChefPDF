import { describe, expect, it } from 'vitest';
import type { SignTemplateEntry } from '@chef/contracts';
import {
  MAX_TEMPLATES,
  addEntry,
  bindTemplate,
  boundTemplate,
  cleanName,
  duplicateEntry,
  newTemplateId,
  removeEntry,
  replaceEntry,
} from './templateList';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

const entry = (id: string, over: Partial<SignTemplateEntry> = {}): SignTemplateEntry => ({
  id,
  name: `Mẫu ${id}`,
  template: { name: id, layout: 'text-only' },
  ...over,
});

describe('template list', () => {
  it('adds, replaces and removes entries', () => {
    const add = addEntry([], entry('t1'));
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(addEntry(add.list, entry('t1')).ok).toBe(false);
    const renamed = replaceEntry(add.list, entry('t1', { name: 'Đổi tên' }));
    expect(renamed[0]!.name).toBe('Đổi tên');
    expect(removeEntry(renamed, 't1')).toEqual([]);
  });

  it('refuses more than the limit', () => {
    const full = Array.from({ length: MAX_TEMPLATES }, (_, i) => entry(`t${i}`));
    expect(addEntry(full, entry('extra'))).toEqual({ ok: false, reason: 'full' });
    expect(duplicateEntry(full, 't0', 'copy')).toEqual({ ok: false, reason: 'full' });
  });

  it('duplicates with a new id, a copy name and no certificate binding', () => {
    const list = [entry('t1', { certFingerprint: FP_A, libraryRefs: { image: 'c'.repeat(32) } })];
    const result = duplicateEntry(list, 't1', 'tcopy');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const copy = result.list[1]!;
    expect(copy.id).toBe('tcopy');
    expect(copy.name).toBe('Mẫu t1 (bản sao)');
    expect(copy.certFingerprint).toBeUndefined();
    expect(copy.libraryRefs).toEqual({ image: 'c'.repeat(32) });
    // The copy does not share the template object with the original.
    copy.template.name = 'changed';
    expect(list[0]!.template.name).toBe('t1');
    expect(duplicateEntry(list, 'missing', 'x')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('binds one template to a certificate and moves the binding', () => {
    let list = [entry('t1'), entry('t2')];
    list = bindTemplate(list, 't1', FP_A.toUpperCase());
    expect(list[0]!.certFingerprint).toBe(FP_A);
    list = bindTemplate(list, 't2', FP_A);
    expect(list[0]!.certFingerprint).toBeUndefined();
    expect(list[1]!.certFingerprint).toBe(FP_A);
    expect(boundTemplate(list, FP_A.toUpperCase())?.id).toBe('t2');
    expect(boundTemplate(list, FP_B)).toBeUndefined();
    expect(boundTemplate(list, null)).toBeUndefined();
  });

  it('unbinds with null', () => {
    const list = bindTemplate([entry('t1', { certFingerprint: FP_B })], 't1', null);
    expect(list[0]!.certFingerprint).toBeUndefined();
  });

  it('trims names and rejects empty ones', () => {
    expect(cleanName('  Chữ ký  ')).toBe('Chữ ký');
    expect(cleanName('   ')).toBeNull();
    expect(cleanName('x'.repeat(200))).toHaveLength(80);
  });

  it('makes ids that the settings validator accepts', () => {
    let n = 0;
    const id = newTemplateId(() => (n++ % 16) / 16);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(id).toHaveLength(17);
  });
});
