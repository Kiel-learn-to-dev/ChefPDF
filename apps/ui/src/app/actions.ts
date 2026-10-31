/**
 * Document-level actions (open, close, save, run ops, undo/redo). UI
 * components call these; they talk to the core through lib/rpc.
 */
import type { OpResult, SessionState } from '@chef/contracts';
import { chef } from '../lib/bridge';
import { ChefError, toChefError } from '../lib/errors';
import type { OpId, OpParams } from '../lib/ops';
import { basename, dirname, join } from '../lib/path';
import { call, runOp } from '../lib/rpc';
import { toast } from '../components/Toast';
import { i18n } from '../i18n';
import { dropThumbnails } from '../features/viewer/thumbnails';
import { releasePdf } from '../features/viewer/pdfCache';
import { getDoc, useDocs } from './state/documents';
import { useSettings } from './state/settings';
import { useViewStore } from './state/viewer';
import { askPassword, confirmDialog } from './prompts';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

export const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }];
export const IMAGE_FILTERS = [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }];

/** Localized message for an error. */
export function errorMessage(e: unknown): string {
  const err = toChefError(e);
  if (err.kind !== 'UNKNOWN' && i18n.exists(`errors.${err.kind}`)) return t(`errors.${err.kind}`);
  return err.message || t('errors.UNKNOWN');
}

export function showError(e: unknown, title = t('errors.title')) {
  const err = toChefError(e);
  if (err.kind === 'CANCELLED') return;
  if (err.kind === 'BLOCKED_BY_SIGNATURE') {
    toast.warning(t('signed.blockedTitle'), t('errors.BLOCKED_BY_SIGNATURE'));
    return;
  }
  toast.error(title, errorMessage(err));
}

// ---------- open ----------

const opening = new Set<string>();

async function openOne(path: string): Promise<void> {
  const existing = useDocs.getState().docs.find((d) => d.state.sourcePath === path);
  if (existing) {
    useDocs.getState().activate(existing.id);
    return;
  }
  if (opening.has(path)) return;
  opening.add(path);
  try {
    let password: string | undefined;
    for (;;) {
      try {
        const { state, info } = await call(
          'session.open',
          password ? { path, password } : { path },
        );
        useDocs
          .getState()
          .add({ id: state.sessionId, name: basename(path), state, info, password });
        void useSettings
          .getState()
          .addRecent(path)
          .catch(() => undefined);
        return;
      } catch (e) {
        const err = toChefError(e);
        if (err.kind === 'PASSWORD_REQUIRED' || err.kind === 'PASSWORD_INVALID') {
          const answer = await askPassword(basename(path), err.kind === 'PASSWORD_INVALID');
          if (answer === null) return;
          password = answer;
          continue;
        }
        throw err;
      }
    }
  } catch (e) {
    showError(e, t('errors.openFailed', { name: basename(path) }));
  } finally {
    opening.delete(path);
  }
}

export async function openFiles(paths: string[]): Promise<void> {
  for (const p of paths) await openOne(p);
}

export async function openWithDialog(): Promise<void> {
  const paths = await chef().files.openDialog({ multiple: true, filters: PDF_FILTERS });
  await openFiles(paths);
}

export interface ProbedPdf {
  path: string;
  pageCount: number;
  fileSize: number;
  password?: string;
  /** 1-based start pages of top-level bookmarks are not available from session.info. */
}

/**
 * Read page count / size of a PDF that is not open as a tab (merge inputs,
 * insert-from-file). The contract has no "info without session" method, so a
 * temporary session is opened and closed again. Returns null when the user
 * cancels the password prompt.
 */
export async function probePdf(path: string): Promise<ProbedPdf | null> {
  let password: string | undefined;
  for (;;) {
    try {
      const r = await call('session.open', password ? { path, password } : { path });
      void call('session.close', { sessionId: r.state.sessionId }).catch(() => undefined);
      return { path, pageCount: r.info.pageCount, fileSize: r.info.fileSize, password };
    } catch (e) {
      const err = toChefError(e);
      if (err.kind !== 'PASSWORD_REQUIRED' && err.kind !== 'PASSWORD_INVALID') throw err;
      const answer = await askPassword(basename(path), err.kind === 'PASSWORD_INVALID');
      if (answer === null) return null;
      password = answer;
    }
  }
}

// ---------- save / close ----------

function defaultDir(): string | null {
  return useSettings.getState().settings.defaultSaveDir;
}

/** Ask where to save a new file; returns null when cancelled. */
export async function pickSavePath(
  suggestedName: string,
  nearPath?: string | null,
): Promise<string | null> {
  const dir = defaultDir() ?? (nearPath ? dirname(nearPath) : '');
  return chef().files.saveDialog({
    defaultPath: dir ? join(dir, suggestedName) : suggestedName,
    filters: PDF_FILTERS,
  });
}

/** Pick a folder with the native directory picker. */
export async function pickFolder(): Promise<string | null> {
  const picked = await chef().files.openDialog({ directory: true });
  return picked[0] ?? null;
}

export async function saveDoc(id: string, saveAs = false): Promise<boolean> {
  const doc = getDoc(id);
  if (!doc) return false;
  let path: string | undefined;
  if (saveAs || !doc.state.sourcePath) {
    const picked = await pickSavePath(
      doc.name.toLowerCase().endsWith('.pdf') ? doc.name : `${doc.name}.pdf`,
      doc.state.sourcePath,
    );
    if (!picked) return false;
    path = picked;
  }
  try {
    // Integrator note: the core returns SessionState & { warnings: string[] } (e.g. owner password not preserved).
    const state = (await call(
      'session.save',
      path ? { sessionId: id, path } : { sessionId: id },
    )) as SessionState & { warnings?: string[] };
    const { warnings = [], ...plain } = state;
    useDocs.getState().applyState(id, plain, []);
    for (const w of warnings) toast.warning(t('save.warning'), w);
    if (path) {
      useDocs.getState().update(id, { name: basename(path) });
      void useSettings
        .getState()
        .addRecent(path)
        .catch(() => undefined);
    }
    toast.success(t('save.saved'), basename(path ?? state.sourcePath ?? doc.name));
    return true;
  } catch (e) {
    showError(e, t('save.failed'));
    return false;
  }
}

/** Close a tab, asking to save unsaved changes. Returns false if the user cancelled. */
export async function closeDoc(id: string): Promise<boolean> {
  const doc = getDoc(id);
  if (!doc) return true;
  if (doc.state.dirty) {
    const answer = await confirmDialog({
      title: t('close.unsavedTitle'),
      message: t('close.unsavedMessage', { name: doc.name }),
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'discard', label: t('close.discard') },
        { id: 'save', label: t('close.save'), variant: 'primary' },
      ],
    });
    if (answer === null || answer === 'cancel') return false;
    if (answer === 'save' && !(await saveDoc(id))) return false;
  }
  useDocs.getState().remove(id);
  useViewStore.getState().drop(id);
  releasePdf(id);
  dropThumbnails(id);
  call('session.close', { sessionId: id }).catch(() => undefined);
  return true;
}

// ---------- ops ----------

async function refreshInfo(id: string) {
  try {
    const info = await call('session.info', { sessionId: id });
    useDocs.getState().update(id, { info });
  } catch {
    /* keep old info */
  }
}

export interface RunDocOpOptions {
  /** Receives the job id once the core accepted the job (progress / cancel). */
  onStarted?(jobId: string): void;
  /** Return true to handle the error yourself (no error toast). */
  onError?(e: unknown): boolean;
  /** Show the result warnings as toasts (default true). */
  toastWarnings?: boolean;
}

/**
 * Run an op on a document session and apply the result (new revision).
 * Returns null when it failed (an error toast was shown, unless onError handled it).
 */
export async function runDocOp<K extends OpId>(
  id: string,
  opId: K,
  params: OpParams[K],
  title: string,
  options: RunDocOpOptions = {},
): Promise<OpResult | null> {
  const docs = useDocs.getState();
  docs.setBusy(id, 1);
  try {
    const result = await runOp(opId, params, {
      sessionId: id,
      title,
      onStarted: options.onStarted,
    });
    const info = await call('session.info', { sessionId: id }).catch(() => undefined);
    // OpResult.state is null for standalone ops; session ops always return it.
    const state = result.state as SessionState | null;
    if (state) useDocs.getState().applyState(id, state, result.changedPages, info);
    if (options.toastWarnings !== false) {
      for (const w of result.warnings) toast.warning(title, w);
    }
    return result;
  } catch (e) {
    if (!options.onError?.(e)) showError(e, t('errors.opFailed', { title }));
    return null;
  } finally {
    useDocs.getState().setBusy(id, -1);
  }
}

export async function undo(id: string) {
  const doc = getDoc(id);
  if (!doc?.state.canUndo) return;
  try {
    const r = await call('session.undo', { sessionId: id });
    if (r.state) useDocs.getState().applyState(id, r.state, r.changedPages);
    await refreshInfo(id);
  } catch (e) {
    showError(e);
  }
}

export async function redo(id: string) {
  const doc = getDoc(id);
  if (!doc?.state.canRedo) return;
  try {
    const r = await call('session.redo', { sessionId: id });
    if (r.state) useDocs.getState().applyState(id, r.state, r.changedPages);
    await refreshInfo(id);
  } catch (e) {
    showError(e);
  }
}

/** Toast offering to open / reveal output files. */
export function announceOutputs(title: string, outputs: string[]) {
  if (outputs.length === 0) return;
  const first = outputs[0]!;
  toast.success(
    title,
    outputs.length === 1 ? basename(first) : t('outputs.count', { count: outputs.length }),
    [
      ...(outputs.length === 1
        ? [{ label: t('outputs.open'), onClick: () => void openFiles([first]) }]
        : []),
      { label: t('outputs.showInFolder'), onClick: () => void chef().files.showInFolder(first) },
    ],
  );
}

export function isChefError(e: unknown): e is ChefError {
  return e instanceof ChefError;
}
