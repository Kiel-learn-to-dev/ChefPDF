/**
 * Actions of the overlay tools: run an overlay op on the open document, keep the last-used
 * options in settings.prefs.overlay, list the overlays, and the file pickers.
 */
import { i18n } from '../../i18n';
import { chef } from '../../lib/bridge';
import { runDocOp, IMAGE_FILTERS, PDF_FILTERS } from '../../app/actions';
import { useSettings } from '../../app/state/settings';
import { toast } from '../../components/Toast';
import type { OpId, OpParams } from '../../lib/ops';
import { runOp } from '../../lib/rpc';
import { readOverlays, type OverlayItem } from './overlayModel';
import { readPrefs, writePrefs } from './overlayPrefs';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

/** Runs an overlay op on the document. Returns true when the core applied it. */
export async function applyOverlay<K extends OpId>(
  docId: string,
  opId: K,
  params: OpParams[K],
  title: string,
  prefs?: { dialog: string; value: unknown },
): Promise<boolean> {
  const result = await runDocOp(docId, opId, params, title);
  if (!result) return false;
  if (prefs) savePrefs(prefs.dialog, prefs.value);
  toast.success(title, t('overlay.applied'));
  return true;
}

/** The last-used options of a dialog (validated, never paths). */
export function prefsOf<T>(
  dialog: string,
  defaults: T,
  enums: Record<string, readonly unknown[]> = {},
): T {
  return readPrefs(useSettings.getState().settings.prefs, dialog, defaults, enums);
}

/** Stores the last-used options of a dialog in settings (fire and forget). */
export function savePrefs(dialog: string, value: unknown): void {
  const { settings, update } = useSettings.getState();
  void update({ prefs: writePrefs(settings.prefs, dialog, value) }).catch(() => undefined);
}

/** The overlays of the open document (overlay.listOverlays; no change to the document). */
export async function listOverlays(docId: string): Promise<OverlayItem[]> {
  const r = await runOp(
    'overlay.listOverlays',
    {},
    {
      sessionId: docId,
      title: t('overlay.manager.job'),
      silent: true,
    },
  );
  return readOverlays(r.data);
}

/** The first image the user picks (PNG or JPEG), or null. */
export async function pickImage(): Promise<string | null> {
  const [path] = await chef().files.openDialog({ multiple: false, filters: IMAGE_FILTERS });
  return path ?? null;
}

/** The PDF files the user picks (several when `multiple`). */
export async function pickPdfs(multiple: boolean): Promise<string[]> {
  return chef().files.openDialog({ multiple, filters: PDF_FILTERS });
}
