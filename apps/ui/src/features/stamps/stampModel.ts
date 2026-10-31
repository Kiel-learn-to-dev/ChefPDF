/**
 * Pure model of the stamps (F2, F3, F5): the text stamp form and its checks, the image stamp
 * form, the built-in presets, and the {date} / {time} / {user} variables shown in the preview.
 * The core fills the placeholders when the stamp is made; the preview uses the same rules.
 */
import type { StampImageParams, StampTextParams } from '@chef/contracts';
import {
  inRange,
  isHexColor,
  pageSelection,
  type Anchor,
  type FormCheck,
  type PagesSel,
  type Unit,
} from '../overlay/overlayModel';
import { formatDate } from '../overlay/variables';

export const MAX_STAMP_TEXT = 200;
/** Variables the stamp text can use (inserted with the chips). */
export const STAMP_CHIPS = ['date', 'time', 'user'] as const;
export type StampChip = (typeof STAMP_CHIPS)[number];

export interface StampPreset {
  id: string;
  title: string;
  text: string;
  color: string;
  borderWidth: number;
  bold: boolean;
  fontSize: number;
}

/** The built-in presets of stamp.presets (core resources/stamps.json). Bad entries are dropped. */
export function readStampPresets(data: unknown): StampPreset[] {
  if (!data || typeof data !== 'object') return [];
  const list = (data as { presets?: unknown }).presets;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): StampPreset[] => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.text !== 'string' || typeof o.title !== 'string') {
      return [];
    }
    return [
      {
        id: o.id,
        title: o.title,
        text: o.text,
        color: typeof o.color === 'string' ? o.color : '#C00000',
        borderWidth: typeof o.borderWidth === 'number' ? o.borderWidth : 2,
        bold: o.bold === true,
        fontSize: typeof o.fontSize === 'number' ? o.fontSize : 24,
      },
    ];
  });
}

export interface TextStampForm {
  text: string;
  color: string;
  borderWidth: number;
  fontSize: number;
  bold: boolean;
  rotation: number;
  opacity: number;
  blendMultiply: boolean;
  x: number;
  y: number;
  unit: Unit;
  anchor: Anchor;
  pages: PagesSel;
}

export const DEFAULT_TEXT_STAMP_FORM: TextStampForm = {
  text: 'ĐÃ DUYỆT',
  color: '#C00000',
  borderWidth: 2,
  fontSize: 24,
  bold: true,
  rotation: 0,
  opacity: 1,
  blendMultiply: false,
  x: 20,
  y: 20,
  unit: 'mm',
  anchor: 'top-left',
  pages: { choice: 'current', range: '' },
};

/** The look of a preset; the position and the pages stay as they are. */
export function presetForm(form: TextStampForm, preset: StampPreset): TextStampForm {
  return {
    ...form,
    text: preset.text,
    color: preset.color,
    borderWidth: preset.borderWidth,
    bold: preset.bold,
    fontSize: preset.fontSize,
  };
}

/** Puts a chip text at the end of the stamp text, on its own spacing. */
export function withChip(text: string, chip: StampChip): string {
  const sep = text === '' || /\s$/.test(text) ? '' : ' ';
  return `${text}${sep}{${chip}}`;
}

/** The stamp text with the variables filled in, as the core will write it (preview only). */
export function resolveStampText(text: string, now: Date, user: string): string {
  return text.replace(/\{(date|time|datetime|user)\}/g, (_match, key: string) => {
    switch (key) {
      case 'date':
        return formatDate(now, 'dd/MM/yyyy');
      case 'time':
        return formatDate(now, 'HH:mm');
      case 'datetime':
        return `${formatDate(now, 'dd/MM/yyyy')} ${formatDate(now, 'HH:mm')}`;
      default:
        return user;
    }
  });
}

export function checkTextStamp(form: TextStampForm, pageCount: number, current: number): FormCheck {
  if (form.text.trim() === '' || form.text.length > MAX_STAMP_TEXT)
    return { ok: false, field: 'text' };
  if (!isHexColor(form.color)) return { ok: false, field: 'color' };
  if (!inRange(form.fontSize, 4, 120)) return { ok: false, field: 'fontSize' };
  if (!inRange(form.borderWidth, 0, 20)) return { ok: false, field: 'borderWidth' };
  if (!inRange(form.rotation, -360, 360)) return { ok: false, field: 'rotation' };
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!inRange(form.x, -10000, 10000) || !inRange(form.y, -10000, 10000)) {
    return { ok: false, field: 'position' };
  }
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

/** The core params of stamp.text. Placeholders stay in the text; the core fills them. */
export function textStampParams(
  form: TextStampForm,
  current: number,
  pageCount: number,
  user: string,
): StampTextParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const pages = sel.ok ? sel.params : {};
  return {
    x: form.x,
    y: form.y,
    unit: form.unit,
    anchor: form.anchor,
    rotation: form.rotation,
    opacity: form.opacity,
    text: form.text,
    fontSize: form.fontSize,
    bold: form.bold,
    color: form.color,
    borderWidth: form.borderWidth,
    blendMultiply: form.blendMultiply,
    user,
    ...pages,
  };
}

export interface ImageStampForm {
  /** Absolute path of the PNG or JPEG (from the library or a file). Never stored in settings. */
  path: string;
  width: number;
  rotation: number;
  opacity: number;
  /** Default on: the seal's ink darkens what is under it. */
  blendMultiply: boolean;
  x: number;
  y: number;
  unit: Unit;
  anchor: Anchor;
  pages: PagesSel;
}

export const DEFAULT_IMAGE_STAMP_FORM: ImageStampForm = {
  path: '',
  width: 40,
  rotation: 0,
  opacity: 1,
  blendMultiply: true,
  x: 20,
  y: 20,
  unit: 'mm',
  anchor: 'top-left',
  pages: { choice: 'current', range: '' },
};

export function checkImageStamp(
  form: ImageStampForm,
  pageCount: number,
  current: number,
): FormCheck {
  if (form.path.trim() === '') return { ok: false, field: 'path' };
  if (!inRange(form.width, 1, 2000)) return { ok: false, field: 'width' };
  if (!inRange(form.rotation, -360, 360)) return { ok: false, field: 'rotation' };
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!inRange(form.x, -10000, 10000) || !inRange(form.y, -10000, 10000)) {
    return { ok: false, field: 'position' };
  }
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

export function imageStampParams(
  form: ImageStampForm,
  current: number,
  pageCount: number,
): StampImageParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const pages = sel.ok ? sel.params : {};
  return {
    x: form.x,
    y: form.y,
    unit: form.unit,
    anchor: form.anchor,
    rotation: form.rotation,
    opacity: form.opacity,
    path: form.path,
    width: form.width,
    blendMultiply: form.blendMultiply,
    ...pages,
  };
}
