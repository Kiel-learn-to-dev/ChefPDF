/**
 * Letterhead (F11): a page of another PDF is placed under (or over) the pages of this document.
 * The letterhead file's pages are shown as thumbnails (pdf.js renders them locally); a click gives
 * the page to a role: first page, odd pages, even pages, or the rest.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileImage } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Checkbox, Field, Segmented, Select, TextInput } from '../../components/Form';
import { TaskDialog } from '../../components/TaskDialog';
import { chef } from '../../lib/bridge';
import { errorMessage, showError } from '../../app/actions';
import { destroyPdf, loadPdf, type PDFDocumentProxy } from '../viewer/pdfjs';
import { renderPageToCanvas } from '../viewer/thumbnails';
import { applyOverlay, pickPdfs, prefsOf } from './overlayActions';
import { PagePreview, PagesField, useCurrentPage } from './OverlayControls';
import {
  DEFAULT_LETTERHEAD_FORM,
  LETTERHEAD_ROLES,
  letterheadParams,
  letterheadProblem,
  type LetterheadForm,
  type LetterheadRole,
} from './overlayModel';
import { useDraft } from './overlayState';
import './overlay.css';

const ENUMS = { scaling: ['none', 'fit'], choice: ['current', 'all', 'range', 'odd', 'even'] };

/** The role a page of the document gets: first page, odd, even, or the rest. */
function roleFor(index: number): LetterheadRole {
  if (index === 0) return 'first';
  return index % 2 === 0 ? 'odd' : 'even';
}

export function LetterheadDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const [form, setForm] = useDraft<LetterheadForm>('letterhead', () =>
    prefsOf('letterhead', DEFAULT_LETTERHEAD_FORM, ENUMS),
  );
  const [role, setRole] = useState<LetterheadRole>('first');
  /** Thumbnails of the file they were rendered from (so a new file shows none until loaded). */
  const [loaded, setLoaded] = useState<{ path: string; urls: string[]; error: string | null }>({
    path: '',
    urls: [],
    error: null,
  });
  const thumbs = loaded.path === form.sourcePath ? loaded.urls : [];
  const loadError = loaded.path === form.sourcePath ? loaded.error : null;
  const [busy, setBusy] = useState(false);
  const current = useCurrentPage(doc?.id);

  // Thumbnails of the letterhead file (rendered with pdf.js; nothing is sent anywhere).
  useEffect(() => {
    const path = form.sourcePath;
    if (!path) return;
    let alive = true;
    let pdf: PDFDocumentProxy | undefined;
    (async () => {
      try {
        pdf = await loadPdf(chef().files.toUrl(path));
        const urls: string[] = [];
        for (let i = 0; i < pdf.numPages; i++) {
          const canvas = await renderPageToCanvas(pdf, i, 110);
          urls.push(canvas.toDataURL('image/png'));
          if (!alive) break;
        }
        if (alive) setLoaded({ path, urls, error: null });
      } catch (e) {
        if (alive) setLoaded({ path, urls: [], error: errorMessage(e) });
      }
    })();
    return () => {
      alive = false;
      if (pdf) void destroyPdf(pdf).catch(() => undefined);
    };
  }, [form.sourcePath]);

  if (!doc) return null;
  const pageCount = doc.info.pageCount;
  const blocked = doc.state.signed;
  const set = (patch: Partial<LetterheadForm>) => setForm((f) => ({ ...f, ...patch }));
  const problem = letterheadProblem(form);
  const used = LETTERHEAD_ROLES.filter((r) => form.roles[r] !== null);
  const pagesOk = form.pages.choice !== 'range' || /\d/.test(form.pages.range);

  const choose = async () => {
    setBusy(true);
    try {
      const [path] = await pickPdfs(false);
      if (path)
        setForm((f) => ({
          ...f,
          sourcePath: path,
          roles: { first: 0, odd: null, even: null, rest: 0 },
        }));
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const pickPage = (index: number) => {
    setForm((f) => ({ ...f, roles: { ...f.roles, [role]: index } }));
  };

  const warnings: string[] = [];
  if (blocked) warnings.push(t('overlay.signedBlocked'));
  if (problem === 'source') warnings.push(t('overlay.letterhead.errSource'));
  if (problem === 'roles') warnings.push(t('overlay.letterhead.errRoles'));
  if (loadError) warnings.push(loadError);

  const run = async () => {
    const ok = await applyOverlay(
      doc.id,
      'overlay.letterhead',
      letterheadParams(form, current, pageCount),
      t('overlay.letterheadJob', { name: doc.name }),
      { dialog: 'letterhead', value: form },
    );
    if (ok) close();
  };

  // Preview: the letterhead page this document page would get.
  const shownRole = roleFor(current);
  const shownIndex = form.roles[shownRole] ?? form.roles.rest ?? form.roles.first;
  const shownUrl = shownIndex !== null && shownIndex !== undefined ? thumbs[shownIndex] : undefined;
  const page = doc.info.pages[current] ?? { width: 595, height: 842 };

  return (
    <TaskDialog
      open
      onOpenChange={(o) => !o && close()}
      title={t('overlay.letterhead.title')}
      icon={<FileImage size={18} />}
      description={t('overlay.letterhead.description')}
      size="xl"
      sideWidth={380}
      runLabel={t('overlay.apply')}
      onRun={() => void run()}
      canRun={!problem && !blocked && pagesOk}
      warnings={warnings}
      preview={
        <PagePreview
          width={page.width}
          height={page.height}
          imageUrl={shownUrl}
          label={t('overlay.preview.page', { page: current + 1 })}
        >
          {!shownUrl && (
            <span className="ov-letterhead-empty">{t('overlay.letterhead.noPreview')}</span>
          )}
        </PagePreview>
      }
      advanced={
        <>
          <Field label={t('overlay.letterhead.scaling')} htmlFor="ov-lh-scaling">
            <Select<'none' | 'fit'>
              id="ov-lh-scaling"
              value={form.scaling}
              onChange={(scaling) => set({ scaling })}
              options={[
                { value: 'fit', label: t('overlay.letterhead.fit') },
                { value: 'none', label: t('overlay.letterhead.none') },
              ]}
              aria-label={t('overlay.letterhead.scaling')}
            />
          </Field>
          <Checkbox
            checked={form.under}
            onChange={(under) => set({ under })}
            label={t('overlay.look.under')}
            hint={t('overlay.letterhead.underHint')}
          />
        </>
      }
    >
      <Field
        label={t('overlay.letterhead.file')}
        htmlFor="ov-lh-file"
        hint={t('overlay.letterhead.fileHint')}
      >
        <div className="field__row">
          <TextInput
            id="ov-lh-file"
            readOnly
            value={form.sourcePath}
            placeholder={t('overlay.letterhead.noFile')}
            aria-invalid={problem === 'source' || undefined}
          />
          <Button onClick={() => void choose()} loading={busy}>
            {t('overlay.letterhead.choose')}
          </Button>
        </div>
      </Field>
      {thumbs.length > 0 && (
        <>
          <Field label={t('overlay.letterhead.role')}>
            <Segmented<LetterheadRole>
              aria-label={t('overlay.letterhead.role')}
              value={role}
              onChange={setRole}
              options={LETTERHEAD_ROLES.map((r) => ({
                value: r,
                label: t(`overlay.letterhead.roles.${r}`),
              }))}
            />
          </Field>
          <div
            className="ov-thumbs"
            role="listbox"
            aria-label={t('overlay.letterhead.pages')}
            data-testid="letterhead-thumbs"
          >
            {thumbs.map((url, i) => {
              const roleHere = used.filter((r) => form.roles[r] === i);
              return (
                <button
                  key={i}
                  type="button"
                  role="option"
                  aria-selected={roleHere.length > 0}
                  className="ov-thumb"
                  data-page={i + 1}
                  onClick={() => pickPage(i)}
                  title={t('overlay.letterhead.pickHint', { page: i + 1 })}
                >
                  <img src={url} alt={t('overlay.letterhead.pageAlt', { page: i + 1 })} />
                  <span className="ov-thumb__label">
                    {i + 1}
                    {roleHere.length > 0 && (
                      <span className="ov-thumb__roles">
                        {roleHere.map((r) => t(`overlay.letterhead.roles.${r}`)).join(' · ')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <PagesField
        id="ov-lh"
        value={form.pages}
        onChange={(pages) => set({ pages })}
        pageCount={pageCount}
        currentPage={current + 1}
      />
    </TaskDialog>
  );
}
