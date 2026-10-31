/**
 * View-model of a certificate card (T3.04, T3.05 display). Pure: no React, no i18n. The
 * components translate the keys returned here.
 */
import type { CertIdentity, CertInfoData } from '@chef/contracts';

export type ExpiryLevel = 'none' | 'soon' | 'expired';

export type IdentityKey = 'organization' | 'personName' | 'taxCode' | 'citizenId' | 'budgetCode';

export interface IdentityLine {
  key: IdentityKey;
  value: string;
}

export interface CertCardView {
  /** Common name, or the full subject when there is no CN. */
  title: string;
  issuer: string;
  serial: string;
  validFrom: string;
  validTo: string;
  expiry: ExpiryLevel;
  /** Negative once expired. */
  daysLeft: number;
  identity: IdentityLine[];
  keyUsage: string[];
  /** Short fingerprint for support requests: the first 16 hex digits, in pairs. */
  fingerprintShort: string;
}

/** Expired beats expiring soon. */
export function expiryLevel(info: Pick<CertInfoData, 'expired' | 'expiringSoon'>): ExpiryLevel {
  if (info.expired) return 'expired';
  if (info.expiringSoon) return 'soon';
  return 'none';
}

/** Identifiers and names that are present, in a fixed display order. */
export function identityLines(identity: CertIdentity): IdentityLine[] {
  const entries: [IdentityKey, string | null][] = [
    ['personName', identity.personName],
    ['organization', identity.organization],
    ['taxCode', identity.taxCode],
    ['citizenId', identity.citizenId],
    ['budgetCode', identity.budgetCode],
  ];
  return entries.flatMap(([key, value]) => (value ? [{ key, value }] : []));
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * dd/MM/yyyy HH:mm in the local time zone (what the user's clock shows). Returns the input
 * unchanged when it is not a valid date.
 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fingerprintShort(hex: string): string {
  const clean = hex.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  return (
    clean
      .slice(0, 16)
      .match(/.{1,2}/g)
      ?.join(':') ?? ''
  );
}

export function certCardView(info: CertInfoData): CertCardView {
  return {
    title: info.subjectCommonName || info.subject,
    issuer: info.issuerCommonName || info.issuer,
    serial: info.serial,
    validFrom: formatDateTime(info.notBefore),
    validTo: formatDateTime(info.notAfter),
    expiry: expiryLevel(info),
    daysLeft: info.daysUntilExpiry,
    identity: identityLines(info.identity),
    keyUsage: info.keyUsage,
    fingerprintShort: fingerprintShort(info.fingerprintSha256),
  };
}
