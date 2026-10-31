/**
 * Operations on the list of saved templates (settings.signTemplates). Pure: the caller stores the
 * result. The list never holds two templates with one id, and at most one template is bound to a
 * certificate (I10: "gắn mẫu với từng chứng thư").
 */
import type { SignTemplateEntry } from '@chef/contracts';
import { MAX_TEMPLATE_LINES } from './templateModel';

export const MAX_TEMPLATES = 50;
const NAME_MAX = 80;

export type ListResult = { ok: true; list: SignTemplateEntry[] } | { ok: false; reason: string };

/** Trimmed, bounded name; null when empty. */
export function cleanName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, NAME_MAX);
}

/** A fresh id: 16 random hex digits (matches the settings validator's id rule). */
export function newTemplateId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 16; i++) id += Math.floor(random() * 16).toString(16);
  return `t${id}`;
}

export function addEntry(list: readonly SignTemplateEntry[], entry: SignTemplateEntry): ListResult {
  if (list.length >= MAX_TEMPLATES) return { ok: false, reason: 'full' };
  if (list.some((e) => e.id === entry.id)) return { ok: false, reason: 'duplicate-id' };
  return { ok: true, list: [...list, entry] };
}

/** Replaces the entry with the same id (its binding and refs are kept only when `next` says so). */
export function replaceEntry(
  list: readonly SignTemplateEntry[],
  next: SignTemplateEntry,
): SignTemplateEntry[] {
  return list.map((e) => (e.id === next.id ? next : e));
}

export function removeEntry(list: readonly SignTemplateEntry[], id: string): SignTemplateEntry[] {
  return list.filter((e) => e.id !== id);
}

/** A copy named "<name> (bản sao)" with no certificate binding (a binding belongs to one template). */
export function duplicateEntry(
  list: readonly SignTemplateEntry[],
  id: string,
  newId: string,
  copySuffix = ' (bản sao)',
): ListResult {
  const source = list.find((e) => e.id === id);
  if (!source) return { ok: false, reason: 'not-found' };
  if (list.length >= MAX_TEMPLATES) return { ok: false, reason: 'full' };
  const base = source.name.slice(0, NAME_MAX - copySuffix.length);
  const copy: SignTemplateEntry = {
    id: newId,
    name: `${base}${copySuffix}`,
    template: structuredClone(source.template),
  };
  if (source.libraryRefs) copy.libraryRefs = { ...source.libraryRefs };
  return { ok: true, list: [...list, copy] };
}

/**
 * Binds `id` to a certificate (or unbinds when fingerprint is null). Any other template bound to
 * that certificate loses the binding. Fingerprints compare case-insensitively.
 */
export function bindTemplate(
  list: readonly SignTemplateEntry[],
  id: string,
  fingerprint: string | null,
): SignTemplateEntry[] {
  const fp = fingerprint?.toLowerCase() ?? null;
  return list.map((e) => {
    const next: SignTemplateEntry = { ...e };
    if (fp && e.certFingerprint === fp && e.id !== id) delete next.certFingerprint;
    if (e.id === id) {
      if (fp) next.certFingerprint = fp;
      else delete next.certFingerprint;
    }
    return next;
  });
}

/** The template bound to a certificate, if any. */
export function boundTemplate(
  list: readonly SignTemplateEntry[],
  fingerprint: string | null | undefined,
): SignTemplateEntry | undefined {
  if (!fingerprint) return undefined;
  const fp = fingerprint.toLowerCase();
  return list.find((e) => e.certFingerprint === fp);
}

/** Lines the list may hold per template (kept here so the studio and the validator agree). */
export const TEMPLATE_LINE_LIMIT = MAX_TEMPLATE_LINES;
