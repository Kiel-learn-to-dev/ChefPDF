/**
 * Pure model of the links (D11, T7.05): the link list, the form of a new or changed link, the
 * URI normalising (a bare domain or an e-mail address gets its scheme), the params of links.add,
 * links.update and links.autoDetect, and the summary of a detection run.
 */
import type { LinksAddParams, LinksUpdateParams } from '@chef/contracts';

/** A link of links.list (rect in the displayed frame, points, origin top-left). */
export interface LinkItem {
  id: string;
  pageIndex: number;
  kind: 'uri' | 'page' | string;
  target: string | null;
  view: 'fit' | 'xyz' | string;
  left: number | null;
  top: number | null;
  rect: number[];
  borderWidth: number;
  color: string | null;
  highlight: 'none' | 'invert' | 'outline' | string;
  flagged?: boolean;
}

export type LinkKind = 'uri' | 'page';

export interface LinkForm {
  kind: LinkKind;
  uri: string;
  /** 1-based page number as typed. */
  targetPage: string;
  view: 'fit' | 'xyz';
  borderWidth: number;
  color: string;
  highlight: 'none' | 'invert' | 'outline';
}

export const DEFAULT_LINK_FORM: LinkForm = {
  kind: 'uri',
  uri: '',
  targetPage: '1',
  view: 'fit',
  borderWidth: 0,
  color: '#0000ff',
  highlight: 'invert',
};

export type LinkFormError = 'URI_REQUIRED' | 'PAGE_INVALID' | 'COLOUR_INVALID';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The URI the user meant: a bare e-mail address becomes mailto:, a bare host becomes https://.
 * Text that already has a scheme (https:, mailto:, ...) is kept as it is.
 */
export function normalizeUri(input: string): string {
  const s = input.trim();
  if (s === '') return '';
  if (SCHEME.test(s)) return s;
  if (EMAIL.test(s)) return `mailto:${s}`;
  return `https://${s}`;
}

/** The first problem of the form, or null when it can be saved. */
export function validateLinkForm(form: LinkForm, pageCount: number): LinkFormError | null {
  if (!HEX.test(form.color)) return 'COLOUR_INVALID';
  if (form.kind === 'uri') {
    return normalizeUri(form.uri) === '' ? 'URI_REQUIRED' : null;
  }
  const page = Number(form.targetPage);
  if (!Number.isInteger(page) || page < 1 || page > pageCount) return 'PAGE_INVALID';
  return null;
}

/** links.add params for a rect drawn on a page (rect: left, top, right, bottom). */
export function addLinkParams(
  pageIndex: number,
  rect: readonly number[],
  form: LinkForm,
): LinksAddParams {
  const base: LinksAddParams = {
    pageIndex,
    rect: [...rect],
    kind: form.kind,
    borderWidth: form.borderWidth,
    color: form.color,
    highlight: form.highlight,
  };
  if (form.kind === 'uri') return { ...base, uri: normalizeUri(form.uri) };
  return { ...base, targetPage: Number(form.targetPage) - 1, view: form.view };
}

/** links.update params: the target and the look of one link. */
export function updateLinkParams(id: string, form: LinkForm): LinksUpdateParams {
  const base: LinksUpdateParams = {
    id,
    borderWidth: form.borderWidth,
    color: form.color,
    highlight: form.highlight,
  };
  if (form.kind === 'uri') return { ...base, uri: normalizeUri(form.uri) };
  return { ...base, targetPage: Number(form.targetPage) - 1, view: form.view };
}

/** The form that shows an existing link. */
export function formOf(link: LinkItem): LinkForm {
  const isUri = link.kind === 'uri';
  return {
    kind: isUri ? 'uri' : 'page',
    uri: isUri ? (link.target ?? '') : '',
    targetPage: isUri ? '1' : String(Number(link.target ?? 0) + 1),
    view: link.view === 'xyz' ? 'xyz' : 'fit',
    borderWidth: link.borderWidth,
    color: link.color ?? '#0000ff',
    highlight:
      link.highlight === 'none' || link.highlight === 'outline' ? link.highlight : 'invert',
  };
}

/** A drag over a page: the rect in points, normalised (left < right, top < bottom). */
export function dragRect(a: { x: number; y: number }, b: { x: number; y: number }): number[] {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)].map(
    (v) => Math.round(v * 1000) / 1000,
  );
}

/** A drag must be this big (points) to make a link; smaller ones are clicks. */
export const MIN_LINK_PT = 4;

export function isLinkSized(rect: readonly number[]): boolean {
  return rect[2]! - rect[0]! >= MIN_LINK_PT && rect[3]! - rect[1]! >= MIN_LINK_PT;
}

/** Links grouped by page, in page order. */
export function groupLinksByPage(
  links: readonly LinkItem[],
): { pageIndex: number; links: LinkItem[] }[] {
  const byPage = new Map<number, LinkItem[]>();
  for (const l of links) {
    const list = byPage.get(l.pageIndex) ?? [];
    list.push(l);
    byPage.set(l.pageIndex, list);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, list]) => ({ pageIndex, links: list }));
}

/** Where a link goes, for the list: the page (1-based) or the URI. */
export function linkTargetText(link: LinkItem): { kind: LinkKind | 'other'; text: string } {
  if (link.kind === 'uri') return { kind: 'uri', text: link.target ?? '' };
  if (link.kind === 'page') return { kind: 'page', text: String(Number(link.target ?? 0) + 1) };
  return { kind: 'other', text: link.target ?? '' };
}

/** links.autoDetect params: every page, existing links are kept (the core skips covered text). */
export function autoDetectParams(pages?: number[]): { pages?: number[]; skipExisting: boolean } {
  return pages && pages.length > 0 ? { pages, skipExisting: true } : { skipExisting: true };
}
