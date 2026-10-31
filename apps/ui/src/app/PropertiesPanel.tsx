import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import {
  ClipboardPaste,
  Copy,
  FileOutput,
  FilePlus,
  ImagePlus,
  Info,
  PanelRightClose,
  RotateCcw,
  RotateCw,
  SquarePlus,
  Trash2,
} from 'lucide-react';
import type { DocTab } from './state/documents';
import { useUi } from './state/ui';
import { useView } from './state/viewer';
import { Button, IconButton } from '../components/Button';
import { Badge } from '../components/Misc';
import { formatBytes, formatPageSize } from '../lib/format';
import { formatPageRanges } from '../lib/pageRange';
import { useSelection } from '../features/pages/pageStore';
import {
  deletePages,
  duplicatePages,
  extractPages,
  insertBlank,
  insertClipboardImage,
  insertionPoint,
  rotatePages,
} from '../features/pages/pageActions';

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="panel__section">
      <h3 className="panel__heading">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="panel__row">
      <span className="panel__key">{k}</span>
      <span className="panel__val">{v}</span>
    </div>
  );
}

function DocumentSection({ doc }: { doc: DocTab }) {
  const { t, i18n } = useTranslation();
  const view = useView(doc.id);
  const page = doc.info.pages[view.page - 1];
  return (
    <Section title={t('panel.document')}>
      <Row k={t('properties.pageCount')} v={doc.info.pageCount} />
      <Row k={t('properties.fileSize')} v={formatBytes(doc.info.fileSize, i18n.language)} />
      <Row k={t('properties.pdfVersion')} v={doc.info.pdfVersion} />
      {page && (
        <Row
          k={t('panel.pageSize')}
          v={formatPageSize(page.width, page.height, i18n.language, t('properties.landscape'))}
        />
      )}
      <Row
        k={t('panel.status')}
        v={doc.state.dirty ? <Badge tone="accent">{t('panel.unsaved')}</Badge> : t('panel.saved')}
      />
      <Button
        size="sm"
        variant="ghost"
        icon={<Info size={14} />}
        className="panel__more"
        onClick={() => useUi.getState().openDialog('properties')}
      >
        {t('panel.allProperties')}
      </Button>
    </Section>
  );
}

function PagesSection({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const sel = useSelection(doc.id);
  const n = sel.selected.length;
  const busy = doc.busy > 0;
  const locked = doc.state.signed;
  const action = (
    label: string,
    icon: ReactNode,
    run: () => void,
    opts: { disabled?: boolean; rewrites?: boolean } = { rewrites: true },
  ) => (
    <Button
      size="sm"
      variant="ghost"
      className="panel__action"
      icon={icon}
      onClick={run}
      disabled={busy || opts.disabled || (opts.rewrites !== false && locked)}
    >
      {label}
    </Button>
  );
  return (
    <>
      <Section
        title={t('panel.selection')}
        aside={n > 0 ? <Badge tone="accent">{n}</Badge> : undefined}
      >
        <p className="panel__text">
          {n === 0
            ? t('panel.noSelection')
            : t('panel.selected', { count: n, ranges: formatPageRanges(sel.selected) })}
        </p>
        {n > 0 && (
          <div className="panel__actions">
            {action(
              t('pages.rotateLeft'),
              <RotateCcw size={14} />,
              () => void rotatePages(doc.id, 270),
            )}
            {action(
              t('pages.rotateRight'),
              <RotateCw size={14} />,
              () => void rotatePages(doc.id, 90),
            )}
            {action(t('pages.duplicate'), <Copy size={14} />, () => void duplicatePages(doc.id))}
            {action(t('pages.extract'), <FileOutput size={14} />, () => void extractPages(doc.id), {
              rewrites: false,
            })}
            {action(t('pages.delete'), <Trash2 size={14} />, () => void deletePages(doc.id), {
              disabled: n >= doc.info.pageCount,
              rewrites: true,
            })}
          </div>
        )}
      </Section>
      <Section title={t('panel.insert')}>
        <div className="panel__actions">
          {action(
            t('cmd.insertBlank'),
            <SquarePlus size={14} />,
            () => void insertBlank(doc.id, insertionPoint(doc.id), 1),
          )}
          {action(t('cmd.insertFromFile'), <FilePlus size={14} />, () =>
            useUi.getState().openDialog('insertFromFile'),
          )}
          {action(t('cmd.insertImages'), <ImagePlus size={14} />, () =>
            useUi.getState().openDialog('insertImages'),
          )}
          {action(
            t('cmd.insertClipboard'),
            <ClipboardPaste size={14} />,
            () => void insertClipboardImage(doc.id),
          )}
        </div>
      </Section>
      <Section title={t('panel.tips')}>
        <ul className="panel__tips">
          <li>{t('panel.tipDrag')}</li>
          <li>{t('panel.tipSelect')}</li>
          <li>{t('panel.tipKeys')}</li>
        </ul>
      </Section>
    </>
  );
}

/** Right properties panel: options/properties of the active tool. */
export function PropertiesPanel({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const tab = useUi((s) => s.functionTab);
  const set = useUi((s) => s.set);
  return (
    <aside className="panel" aria-label={t('panel.label')}>
      <div className="panel__top">
        <span className="panel__name" title={doc.name}>
          {tab === 'pages' ? t('panel.pagesTitle') : doc.name}
        </span>
        <IconButton
          size="sm"
          label={t('panel.hide')}
          icon={<PanelRightClose size={15} />}
          onClick={() => set({ panelOpen: false })}
        />
      </div>
      <div className="panel__body">
        {tab === 'pages' ? <PagesSection doc={doc} /> : <DocumentSection doc={doc} />}
      </div>
    </aside>
  );
}
