/**
 * Calls the signing ops need on an open document (placement, fields, anchors, templates). The
 * signing itself is in SignDocDialog / BatchSignDialog through runDocOp.
 */
import type { SignTemplateEntry, SignatureTemplate } from '@chef/contracts';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { runDocOp } from '../../app/actions';
import { getDoc, type DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useSettings } from '../../app/state/settings';
import { i18n } from '../../i18n';
import { fromWire } from '../signTemplate/templateModel';
import {
  placeFromAnchorParams,
  rememberAnchor,
  type AnchorForm,
  type FixedForm,
} from './anchorModel';
import { fixedRectUser, mmToPt, pageGeom, type PageGeom } from './placementGeometry';
import { writeSignPrefs } from './signPrefs';
import { type AnchorPreview, type PlacedBox } from './placementStore';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

export interface FieldInfo {
  fieldName: string;
  page: number;
  rect: number[] | null;
  signed: boolean;
}

interface FindAnchorsData {
  matches: { pageIndex: number; rect: number[] }[];
  truncated: boolean;
}

interface PlaceData {
  placements: { pageIndex: number; rect: number[] }[];
  skipped: number;
}

export function pageGeomOf(doc: DocTab | undefined, pageIndex: number): PageGeom | null {
  const page = doc?.info.pages[pageIndex];
  return page ? pageGeom(page) : null;
}

/** Empty signature fields of the document (sign.listFields without the signed ones). */
export async function listEmptyFields(docId: string): Promise<FieldInfo[]> {
  const r = await runOp(
    'sign.listFields',
    {},
    { sessionId: docId, title: t('sign.fieldsJob'), silent: true },
  );
  const fields = (r.data as { fields?: FieldInfo[] } | null)?.fields ?? [];
  return fields.filter((f) => !f.signed && f.rect !== null);
}

/** Which matches an anchor placement uses (first, last or all). */
export function pickMatches<T>(matches: readonly T[], which: 'first' | 'last' | 'all'): T[] {
  if (which === 'all') return [...matches];
  if (which === 'last') return matches.slice(-1);
  return matches.slice(0, 1);
}

/**
 * Finds the anchor text and proposes the boxes (I26). Nothing is written to the document; the
 * caller shows the previews.
 */
export async function previewAnchors(
  docId: string,
  form: AnchorForm,
): Promise<{ previews: AnchorPreview[]; found: number; truncated: boolean }> {
  const found = await runOp(
    'sign.findAnchors',
    {
      text: form.text.trim(),
      ignoreDiacritics: form.ignoreDiacritics,
      caseSensitive: false,
      wholeWord: true,
      maxResults: 200,
    },
    { sessionId: docId, title: t('sign.anchorJob'), silent: true },
  );
  const data = found.data as FindAnchorsData | null;
  const matches = data?.matches ?? [];
  const chosen = pickMatches(matches, form.whichMatch);
  if (chosen.length === 0) return { previews: [], found: 0, truncated: !!data?.truncated };
  const placed = await runOp('sign.placeFromAnchor', placeFromAnchorParams(form, chosen), {
    sessionId: docId,
    title: t('sign.anchorJob'),
    silent: true,
  });
  const placements = (placed.data as PlaceData | null)?.placements ?? [];
  const previews = placements.map((p) => ({
    pageIndex: p.pageIndex,
    rect: [p.rect[0]!, p.rect[1]!, p.rect[2]!, p.rect[3]!] as AnchorPreview['rect'],
  }));
  return { previews, found: matches.length, truncated: !!data?.truncated };
}

/** The fixed box of a page corner (I27) as a placement. Null when the page does not exist. */
export function fixedBox(docId: string, form: FixedForm): PlacedBox | null {
  const doc = getDoc(docId);
  if (!doc) return null;
  const count = doc.info.pageCount;
  const index = form.page === 'first' ? 0 : form.page === 'last' ? count - 1 : form.page;
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  const g = pageGeomOf(doc, index);
  if (!g) return null;
  const rect = fixedRectUser(
    form.corner,
    mmToPt(form.widthMm),
    mmToPt(form.heightMm),
    form.marginPt,
    g,
  );
  return { pageIndex: index, rect, source: 'fixed' };
}

/** Adds an empty signature field (I24-I25 "thêm ô ký trống"). Returns the field name. */
export async function addEmptyField(
  docId: string,
  box: PlacedBox,
  signerLabel: string,
): Promise<string | null> {
  const label = signerLabel.trim();
  const result = await runDocOp(
    docId,
    'sign.addField',
    {
      page: box.pageIndex,
      rect: [...box.rect],
      ...(label ? { signerLabel: label } : {}),
    },
    t('sign.addFieldJob'),
  );
  return (result?.data as { fieldName?: string } | null | undefined)?.fieldName ?? null;
}

export interface MaterializedTemplate {
  template: SignatureTemplate;
  /** Deletes the decrypted image copies. Call after the op, also on failure. */
  release(): Promise<void>;
}

/**
 * The template of a saved entry, with its library images decrypted to work files (I18). The
 * PNG copies exist only until release() runs.
 */
export async function materializeTemplate(entry: SignTemplateEntry): Promise<MaterializedTemplate> {
  const template = fromWire(entry.template);
  const made: string[] = [];
  const refs = entry.libraryRefs ?? {};
  try {
    if (refs.image) {
      const path = await chef().library.materialize(refs.image);
      made.push(path);
      template.image = { path, fit: 'contain', opacity: 1 };
    }
    if (refs.logo) {
      const path = await chef().library.materialize(refs.logo);
      made.push(path);
      template.logo = { path, fit: 'contain', opacity: 1 };
    }
  } catch (e) {
    await releaseFiles(made);
    throw e;
  }
  return { template, release: () => releaseFiles(made) };
}

async function releaseFiles(paths: string[]): Promise<void> {
  for (const p of paths)
    await chef()
      .library.release(p)
      .catch(() => undefined);
}

/** Remembers the last box size (settings.prefs.sign.boxMm). Failures are ignored. */
export async function rememberBoxSize(w: number, h: number): Promise<void> {
  const s = useSettings.getState().settings;
  await useSettings
    .getState()
    .update({ prefs: writeSignPrefs(s.prefs, { boxMm: { w, h } }) })
    .catch(() => undefined);
}

/** Remembers a recent anchor text. */
export async function rememberAnchorText(text: string, list: readonly string[]) {
  const s = useSettings.getState().settings;
  await useSettings
    .getState()
    .update({ prefs: writeSignPrefs(s.prefs, { anchors: rememberAnchor(list, text) }) })
    .catch(() => undefined);
}

/** After a successful signature: the signature panel shows the new signature and is verified. */
export function showSignaturesPanel(): void {
  useUi.getState().set({ sidebarOpen: true, sidebarTab: 'signatures', functionTab: 'sign' });
}
