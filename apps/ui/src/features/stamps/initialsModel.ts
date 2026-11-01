/**
 * Pure model of the initials (chữ ký nháy, F6): text or image, one of nine anchor positions,
 * margin, size, the pages, and the core params of stamp.initials.
 */
import type { StampInitialsParams } from '@chef/contracts';
import { inRange, pageSelection, type FormCheck, type PagesSel } from '../overlay/overlayModel';

export type InitialsKind = 'text' | 'image';
export type InitialsPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/** The nine positions, row by row (top to bottom, left to right). */
export const INITIALS_POSITIONS: InitialsPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export const MAX_INITIALS_TEXT = 40;

export interface InitialsForm {
  kind: InitialsKind;
  text: string;
  /** Absolute path of the initials image. Never stored in preferences. */
  path: string;
  position: InitialsPosition;
  marginMm: number;
  /** Image width (image only). */
  widthMm: number;
  /** Text size (text only). */
  fontSize: number;
  bold: boolean;
  color: string;
  opacity: number;
  blendMultiply: boolean;
  pages: PagesSel;
}

export const DEFAULT_INITIALS_FORM: InitialsForm = {
  kind: 'text',
  text: 'KN',
  path: '',
  position: 'bottom-right',
  marginMm: 10,
  widthMm: 25,
  fontSize: 14,
  bold: false,
  color: '#1F4E9A',
  opacity: 1,
  blendMultiply: false,
  pages: { choice: 'all', range: '' },
};

export function checkInitials(form: InitialsForm, pageCount: number, current: number): FormCheck {
  if (form.kind === 'text') {
    if (form.text.trim() === '' || form.text.length > MAX_INITIALS_TEXT) {
      return { ok: false, field: 'text' };
    }
    if (!inRange(form.fontSize, 4, 120)) return { ok: false, field: 'fontSize' };
  } else {
    if (form.path.trim() === '') return { ok: false, field: 'path' };
    if (!inRange(form.widthMm, 1, 500)) return { ok: false, field: 'widthMm' };
  }
  if (!inRange(form.marginMm, 0, 100)) return { ok: false, field: 'marginMm' };
  if (!/^#[0-9a-fA-F]{6}$/.test(form.color)) return { ok: false, field: 'color' };
  if (!inRange(form.opacity, 0, 1)) return { ok: false, field: 'opacity' };
  if (!pageSelection(form.pages, current, pageCount).ok) return { ok: false, field: 'pages' };
  return { ok: true };
}

/** The core params of stamp.initials. Only the active kind's content is sent. */
export function initialsParams(
  form: InitialsForm,
  current: number,
  pageCount: number,
): StampInitialsParams {
  const sel = pageSelection(form.pages, current, pageCount);
  const pages = sel.ok ? sel.params : {};
  const content =
    form.kind === 'text'
      ? { text: form.text, fontSize: form.fontSize, bold: form.bold, color: form.color }
      : { path: form.path, widthMm: form.widthMm };
  return {
    position: form.position,
    marginMm: form.marginMm,
    opacity: form.opacity,
    blendMultiply: form.blendMultiply,
    ...content,
    ...pages,
  };
}

/** Where the position sits on a page, as fractions 0..1 of width and height (preview only). */
export function positionFraction(position: InitialsPosition): { x: number; y: number } {
  const [v, h] = position.split('-');
  const x = h === 'left' ? 0.1 : h === 'right' ? 0.9 : 0.5;
  const y = v === 'top' ? 0.1 : v === 'bottom' ? 0.9 : 0.5;
  return { x: position === 'center' ? 0.5 : x, y: position === 'center' ? 0.5 : y };
}
