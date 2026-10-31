import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import clsx from 'clsx';
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  FileClock,
  History,
  RefreshCw,
  ShieldCheck,
  Settings2,
} from 'lucide-react';
import type { SignatureVerifyItem } from '@chef/contracts';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { openFiles, showError } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Badge, EmptyState, Spinner } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { join, stripExt } from '../../lib/path';
import { runOp } from '../../lib/rpc';
import {
  STATUS_STYLE,
  chainView,
  commonNameOf,
  formatDateTime,
  levelLabel,
  reasonText,
  signerOf,
  summaryOf,
  type StatusIcon,
  type UiLang,
} from './verifyModel';
import { scheduleVerify, useVerifyStore } from './verifyStore';
import './signatures.css';

const ICONS: Record<StatusIcon, typeof CircleCheck> = {
  check: CircleCheck,
  alert: CircleAlert,
  x: CircleX,
  help: CircleHelp,
  minus: CircleMinus,
};

export function langOf(i18nLanguage: string): UiLang {
  return i18nLanguage.startsWith('en') ? 'en' : 'vi';
}

/** Status badge: icon and text carry the meaning, the colour only adds emphasis. */
export function StatusBadge({
  status,
  t,
}: {
  status: SignatureVerifyItem['status'];
  t: TFunction;
}) {
  const style = STATUS_STYLE[status];
  const Icon = ICONS[style.icon];
  return (
    <span className={clsx('sig-badge', `sig-badge--${style.tone}`)} data-status={status}>
      <Icon size={14} aria-hidden />
      <span>{t(style.labelKey)}</span>
    </span>
  );
}

/** Saves the document as it was when this signature was applied and opens it as a new tab (I34). */
export async function openSignedVersion(doc: DocTab, item: SignatureVerifyItem): Promise<void> {
  try {
    const dir = await chef().library.workDir();
    const base = stripExt(doc.name).replace(/[^\w.-]+/g, '_') || 'document';
    const salt = Math.random().toString(36).slice(2, 8);
    const outputPath = join(dir, `${base}_${item.fieldName}_${salt}.pdf`);
    await runOp(
      'sign.extractRevision',
      { path: doc.state.revisionPath, fieldName: item.fieldName, outputPath },
      { title: 'Phiên bản lúc ký', silent: true },
    );
    await openFiles([outputPath]);
  } catch (e) {
    showError(e);
  }
}

function Detail({
  item,
  doc,
  lang,
  t,
}: {
  item: SignatureVerifyItem;
  doc: DocTab;
  lang: UiLang;
  t: TFunction;
}) {
  const time = (iso: string | null) => formatDateTime(iso, lang) ?? t('sig.panel.none');
  const chain = chainView(item);
  return (
    <div className="sig-detail" id={`sig-detail-${item.fieldName}`}>
      <p className="sig-detail__summary">{summaryOf(item, lang)}</p>

      {item.reasons.length > 0 && (
        <section className="sig-detail__section">
          <h4>{t('sig.panel.reasons')}</h4>
          <ul className="sig-detail__list">
            {item.reasons.map((r) => (
              <li key={r}>
                <code>{r}</code> {reasonText(r, lang)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sig-detail__section">
        <h4>{t('sig.panel.chain')}</h4>
        {chain.length === 0 ? (
          <p className="sig-detail__muted">{t('sig.panel.noChain')}</p>
        ) : (
          <ol className="sig-chain">
            {chain.map((c, i) => (
              <li key={`${c.subject}-${i}`} className="sig-chain__row">
                <span className="sig-chain__name">{commonNameOf(c.subject)}</span>
                <span className={clsx('sig-tag', c.trusted ? 'sig-tag--ok' : 'sig-tag--warn')}>
                  {c.trusted ? t('sig.panel.trusted') : t('sig.panel.notTrusted')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="sig-detail__section">
        <h4>{t('sig.panel.revocation')}</h4>
        {item.revocation.length === 0 ? (
          <p className="sig-detail__muted">{t('sig.panel.noRevocation')}</p>
        ) : (
          <ul className="sig-detail__list">
            {item.revocation.map((r) => (
              <li key={`${r.fingerprintSha256}-${r.source}`}>
                {commonNameOf(r.cert)}:{' '}
                {t(`sig.panel.revStatus.${r.status}`, { defaultValue: r.status })}{' '}
                <span className="sig-detail__muted">
                  ({t(`sig.panel.revSource.${r.source}`, { defaultValue: r.source })})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <dl className="sig-detail__facts">
        <dt>{t('sig.panel.signingTime')}</dt>
        <dd>{time(item.signingTime)}</dd>
        {item.timestampTime && (
          <>
            <dt>{t('sig.panel.timestamp')}</dt>
            <dd>
              {time(item.timestampTime)}
              {item.timestampOk === false && ` · ${t('sig.panel.timestampBad')}`}
            </dd>
          </>
        )}
        <dt>{t('sig.panel.coverage')}</dt>
        <dd>
          {item.coversWholeDocument === false ? t('sig.panel.partial') : t('sig.panel.whole')}
        </dd>
        {item.revisionIndex !== null && (
          <>
            <dt>{t('sig.panel.revision')}</dt>
            <dd>{t('sig.panel.revisionNo', { n: item.revisionIndex })}</dd>
          </>
        )}
      </dl>

      {item.revisionIndex !== null && (
        <Button
          size="sm"
          variant="secondary"
          icon={<History size={14} />}
          onClick={() => void openSignedVersion(doc, item)}
        >
          {t('sig.panel.viewVersion')}
        </Button>
      )}
    </div>
  );
}

/** Left-sidebar panel "Chữ ký" (I34): one row per signature, with details on demand. */
export function SignaturePanel({ doc }: { doc: DocTab }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const entry = useVerifyStore((s) => s.byDoc[doc.id]);
  const [open, setOpen] = useState<string | null>(null);
  const items = entry?.items ?? [];
  const phase = entry?.phase ?? 'idle';

  if (!doc.info.hasSignatures) {
    return (
      <div className="sig-panel">
        <EmptyState
          icon={<FileClock size={22} />}
          title={t('sig.panel.emptyTitle')}
          text={t('sig.panel.empty')}
        />
      </div>
    );
  }

  const rerun = () => scheduleVerify(doc.id, `${doc.state.revisionPath}#${doc.state.revision}`, 0);

  return (
    <div className="sig-panel">
      <div className="sig-panel__bar">
        <Button
          size="sm"
          variant="ghost"
          icon={<Settings2 size={14} />}
          onClick={() => useUi.getState().openDialog('trust')}
        >
          {t('sig.panel.trustSettings')}
        </Button>
        <IconButton
          size="sm"
          label={t('sig.panel.refresh')}
          icon={<RefreshCw size={14} />}
          onClick={rerun}
        />
      </div>

      {phase === 'running' && items.length === 0 && (
        <p className="sig-panel__status" role="status">
          <Spinner size={14} /> {t('sig.panel.running')}
        </p>
      )}
      {phase === 'error' && (
        <p className="sig-panel__error" role="alert">
          <CircleAlert size={14} aria-hidden />{' '}
          {t('sig.panel.error', { message: entry?.error ?? '' })}
        </p>
      )}

      <ul className="sig-list" aria-label={t('sig.panel.listLabel')}>
        {items.map((item) => {
          const expanded = open === item.fieldName;
          return (
            <li key={item.fieldName} className="sig-item">
              <div className="sig-item__head">
                <StatusBadge status={item.status} t={t} />
                {levelLabel(item) && <Badge>{levelLabel(item)}</Badge>}
              </div>
              <div className="sig-item__who">{signerOf(item)}</div>
              <div className="sig-item__meta">
                {formatDateTime(item.signingTime, lang) ?? t('sig.panel.noTime')}
                {' · '}
                {item.fieldName}
              </div>
              <button
                type="button"
                className="sig-item__toggle"
                aria-expanded={expanded}
                aria-controls={`sig-detail-${item.fieldName}`}
                onClick={() => setOpen(expanded ? null : item.fieldName)}
              >
                {expanded ? t('sig.panel.hideDetail') : t('sig.panel.showDetail')}
              </button>
              {expanded && <Detail item={item} doc={doc} lang={lang} t={t} />}
            </li>
          );
        })}
      </ul>

      <p className="sig-panel__foot">
        <ShieldCheck size={13} aria-hidden /> {t('sig.panel.footnote')}
      </p>
    </div>
  );
}
