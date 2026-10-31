import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import type { DocumentInfo } from '@chef/contracts';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useView } from '../../app/state/viewer';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Misc';
import { call } from '../../lib/rpc';
import { formatBytes, formatDate, formatPageSize } from '../../lib/format';
import './PropertiesDialog.css';

const META_KEYS = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
] as const;

/** Document properties (B7) from session.info. */
export function PropertiesDialog() {
  const { t, i18n } = useTranslation();
  const doc = useActiveDoc();
  const view = useView(doc?.id);
  const close = useUi((s) => s.closeDialog);
  const [info, setInfo] = useState<DocumentInfo | undefined>(doc?.info);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    call('session.info', { sessionId: doc.id })
      .then((i) => !cancelled && setInfo(i))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (!doc || !info) return null;
  const lang = i18n.language;
  const page = info.pages[Math.max(0, view.page - 1)];
  const meta = (k: string) => {
    const v = info.metadata[k];
    if (!v) return <span className="muted">–</span>;
    return k.endsWith('Date') ? formatDate(v, lang) : v;
  };
  const rows: [string, React.ReactNode][] = [
    [t('properties.file'), doc.name],
    [
      t('properties.location'),
      <span className="props__path">{doc.state.sourcePath ?? t('properties.unsaved')}</span>,
    ],
    [t('properties.fileSize'), formatBytes(info.fileSize, lang)],
    [t('properties.pdfVersion'), info.pdfVersion],
    [t('properties.pageCount'), String(info.pageCount)],
    [
      t('properties.pageSize'),
      page
        ? `${formatPageSize(page.width, page.height, lang, t('properties.landscape'))} · ${t('properties.pageN', { page: view.page })}`
        : '–',
    ],
    [
      t('properties.security'),
      info.encrypted ? t('properties.encrypted') : t('properties.notEncrypted'),
    ],
    [
      t('properties.signatures'),
      info.hasSignatures ? t('properties.hasSignatures') : t('properties.noSignatures'),
    ],
  ];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      size="lg"
      icon={<Info size={18} />}
      title={t('properties.title')}
      footer={
        <>
          <DialogSpacer />
          <Button variant="primary" onClick={close}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k} className="props__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="props__heading">{t('properties.metadata')}</h3>
      <dl className="props">
        {META_KEYS.map((k) => (
          <div key={k} className="props__row">
            <dt>{t(`properties.meta.${k}`)}</dt>
            <dd>{meta(k)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="props__heading">
        {t('properties.fonts')} <Badge>{info.fonts.length}</Badge>
      </h3>
      {info.fonts.length === 0 ? (
        <p className="muted">{t('properties.noFonts')}</p>
      ) : (
        <ul className="props__fonts">
          {info.fonts.map((f) => (
            <li key={f.name}>
              <span>{f.name}</span>
              <span className="props__font-tags">
                {f.embedded ? (
                  <Badge tone="accent">{t('properties.embedded')}</Badge>
                ) : (
                  <Badge>{t('properties.notEmbedded')}</Badge>
                )}
                {f.subset && <Badge>{t('properties.subset')}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
