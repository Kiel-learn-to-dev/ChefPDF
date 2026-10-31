import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import clsx from 'clsx';
import { TriangleAlert } from 'lucide-react';
import type { CertInfoData } from '@chef/contracts';
import { certCardView, type IdentityKey } from './certModel';

/** Translated label of an identity line. Literal keys so the i18n check can see them. */
function identityLabel(t: TFunction, key: IdentityKey): string {
  switch (key) {
    case 'personName':
      return t('certs.identity.personName');
    case 'organization':
      return t('certs.identity.organization');
    case 'taxCode':
      return t('certs.identity.taxCode');
    case 'citizenId':
      return t('certs.identity.citizenId');
    case 'budgetCode':
      return t('certs.identity.budgetCode');
  }
}

/** Certificate facts for the user: names, identifiers, validity, with an expiry banner. */
export function CertCard({ info }: { info: CertInfoData }) {
  const { t } = useTranslation();
  const view = certCardView(info);
  const expired = view.expiry === 'expired';
  return (
    <article className={clsx('cert-card', `cert-card--${view.expiry}`)}>
      {view.expiry !== 'none' && (
        <div
          className={clsx('cert-banner', `cert-banner--${view.expiry}`)}
          role={expired ? 'alert' : 'status'}
        >
          <TriangleAlert size={16} aria-hidden />
          <span className="cert-banner__text">
            {expired ? t('certs.expiry.expired') : t('certs.expiry.soon')}
          </span>
          <span className="cert-banner__days">
            {expired
              ? t('certs.card.expiredDays', { days: Math.abs(view.daysLeft) })
              : t('certs.card.daysLeft', { days: view.daysLeft })}
          </span>
        </div>
      )}
      <h3 className="cert-card__name">{view.title}</h3>
      <dl className="cert-card__facts">
        <dt>{t('certs.card.issuer')}</dt>
        <dd>{view.issuer}</dd>
        <dt>{t('certs.card.validFrom')}</dt>
        <dd>{view.validFrom}</dd>
        <dt>{t('certs.card.validTo')}</dt>
        <dd>{view.validTo}</dd>
        <dt>{t('certs.card.serial')}</dt>
        <dd className="cert-card__mono">{view.serial}</dd>
        {view.keyUsage.length > 0 && (
          <>
            <dt>{t('certs.card.usage')}</dt>
            <dd>{view.keyUsage.join(', ')}</dd>
          </>
        )}
        <dt>{t('certs.card.fingerprint')}</dt>
        <dd className="cert-card__mono">{view.fingerprintShort}</dd>
      </dl>
      {view.identity.length > 0 ? (
        <dl className="cert-card__identity">
          {view.identity.map((line) => (
            <div key={line.key} className="cert-card__line">
              <dt>{identityLabel(t, line.key)}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="cert-card__none">{t('certs.card.noIdentity')}</p>
      )}
    </article>
  );
}
