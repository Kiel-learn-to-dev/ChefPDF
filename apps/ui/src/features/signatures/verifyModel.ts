/**
 * View model of the signature validation panel (I34). Pure: no React, no bridge.
 */
import type { SignatureReason, SignatureStatus, SignatureVerifyItem } from '@chef/contracts';

export type UiLang = 'vi' | 'en';

/** Most severe first: what needs attention comes at the top of the panel. */
export const STATUS_ORDER: readonly SignatureStatus[] = [
  'invalid',
  'unknown',
  'valid-with-warnings',
  'valid',
  'unsigned',
];

export function statusRank(status: SignatureStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/** Stable sort by severity (the document order is kept inside one status). */
export function sortBySeverity(items: readonly SignatureVerifyItem[]): SignatureVerifyItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => statusRank(a.item.status) - statusRank(b.item.status) || a.index - b.index)
    .map(({ item }) => item);
}

export type StatusIcon = 'check' | 'alert' | 'x' | 'help' | 'minus';
export type StatusTone = 'ok' | 'warn' | 'bad' | 'unknown' | 'neutral';

export interface StatusStyle {
  tone: StatusTone;
  icon: StatusIcon;
  /** i18n key of the badge text. */
  labelKey: string;
}

/** Colour is never the only signal: each status also has an icon and a text. */
export const STATUS_STYLE: Record<SignatureStatus, StatusStyle> = {
  valid: { tone: 'ok', icon: 'check', labelKey: 'sig.status.valid' },
  'valid-with-warnings': { tone: 'warn', icon: 'alert', labelKey: 'sig.status.validWarn' },
  invalid: { tone: 'bad', icon: 'x', labelKey: 'sig.status.invalid' },
  unknown: { tone: 'unknown', icon: 'help', labelKey: 'sig.status.unknown' },
  unsigned: { tone: 'neutral', icon: 'minus', labelKey: 'sig.status.unsigned' },
};

/**
 * Reason codes of the core (core/chef_core/signing/verify.py REASON_TEXT) with Vietnamese and
 * English texts. The core sends the same texts in summaryVi / summaryEn; these are the fallback.
 */
export const REASON_TEXT: Record<SignatureReason, { vi: string; en: string }> = {
  INTEGRITY_FAILED: {
    vi: 'nội dung đã ký bị thay đổi',
    en: 'the signed content was changed',
  },
  MODIFIED_AFTER_SIGNING: {
    vi: 'tài liệu được sửa sau khi ký',
    en: 'the document changed after signing',
  },
  CERT_UNTRUSTED: {
    vi: 'chứng thư không thuộc kho tin cậy',
    en: 'the certificate is not trusted',
  },
  CERT_REVOKED: {
    vi: 'chứng thư đã bị thu hồi',
    en: 'the certificate has been revoked',
  },
  CERT_EXPIRED_AT_SIGNING: {
    vi: 'chứng thư đã hết hạn tại thời điểm ký',
    en: 'the certificate had expired when it was signed',
  },
  CERT_EXPIRED_NOW: {
    vi: 'chứng thư đã hết hạn và không có dấu thời gian',
    en: 'the certificate has expired and there is no timestamp',
  },
  REVOCATION_UNKNOWN: {
    vi: 'chưa kiểm tra được trạng thái thu hồi',
    en: 'revocation status could not be checked',
  },
  WEAK_KEY: {
    vi: 'chứng thư dùng khóa RSA dưới 2048 bit (yếu)',
    en: 'the certificate uses an RSA key under 2048 bits (weak)',
  },
  DOCMDP_VIOLATION: {
    vi: 'thay đổi vi phạm quyền của chữ ký chứng nhận',
    en: 'a change breaks the certification permissions',
  },
  TIMESTAMP_INVALID: {
    vi: 'dấu thời gian không hợp lệ',
    en: 'the timestamp is not valid',
  },
  UNSIGNED_FIELD: {
    vi: 'ô chữ ký chưa được ký',
    en: 'the signature field is not signed',
  },
  SIGNATURE_UNREADABLE: {
    vi: 'không đọc được dữ liệu chữ ký',
    en: 'the signature data cannot be read',
  },
};

/** Translated text of one reason; unknown codes are shown as they are. */
export function reasonText(reason: string, lang: UiLang): string {
  const entry = (REASON_TEXT as Record<string, { vi: string; en: string } | undefined>)[reason];
  return entry ? entry[lang] : reason;
}

/** The core's summary when present, otherwise the translated reasons joined. */
export function summaryOf(item: SignatureVerifyItem, lang: UiLang): string {
  const core = lang === 'vi' ? item.summaryVi : item.summaryEn;
  if (core && core.trim().length > 0) return core;
  const reasons = item.reasons.map((r) => reasonText(r, lang));
  return reasons.length > 0 ? reasons.join('; ') : '';
}

/** Signer shown in the list: the certificate's person, then the organisation, then the field. */
export function signerOf(item: SignatureVerifyItem): string {
  return item.signerName ?? item.signerCert?.subjectCommonName ?? item.fieldName;
}

export interface ChipSummary {
  tone: StatusTone;
  /** i18n key; the count is interpolated as `count`. */
  key: string;
  count: number;
}

/**
 * Status-bar chip: the most severe state that the document has. Null when there is no signature
 * to report (no signed field).
 */
export function chipSummary(items: readonly SignatureVerifyItem[]): ChipSummary | null {
  const count = (status: SignatureStatus) => items.filter((i) => i.status === status).length;
  const invalid = count('invalid');
  if (invalid > 0) return { tone: 'bad', key: 'sig.chip.invalid', count: invalid };
  const unknown = count('unknown');
  if (unknown > 0) return { tone: 'unknown', key: 'sig.chip.unknown', count: unknown };
  const warn = count('valid-with-warnings');
  if (warn > 0) return { tone: 'warn', key: 'sig.chip.validWarn', count: warn };
  const valid = count('valid');
  if (valid > 0) return { tone: 'ok', key: 'sig.chip.valid', count: valid };
  return null;
}

/**
 * Date and time for display, e.g. "31/10/2026 08:02:03" (vi) or "31/10/2026, 08:02:03" (en).
 * Null for a missing or invalid value. `timeZone` defaults to the machine's zone.
 */
export function formatDateTime(
  iso: string | null | undefined,
  _lang: UiLang,
  timeZone?: string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // en-GB gives dd/MM/yyyy and HH:mm:ss for both languages (the Vietnamese convention too), so
  // the date and the time are built separately and the order never depends on the locale.
  const zone = timeZone ? { timeZone } : {};
  const day = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...zone,
  }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...zone,
  }).format(date);
  return `${day} ${time}`;
}

/** Level badge text: B-B, B-T, B-LT or B-LTA; null when the core gave no level. */
export function levelLabel(item: SignatureVerifyItem): string | null {
  return item.level;
}

export interface ChainView {
  subject: string;
  issuer: string;
  trusted: boolean;
}

/** Chain rows in the order the core gives them (signer first, then issuers). */
export function chainView(item: SignatureVerifyItem): ChainView[] {
  return item.chain.map((c) => ({ subject: c.subject, issuer: c.issuer, trusted: c.trusted }));
}

/** Common name from an RFC 4514 string such as "CN=Nguyễn Văn An,O=…", or the whole string. */
export function commonNameOf(rfc4514: string): string {
  const match = /(?:^|,)\s*CN=([^,]+)/.exec(rfc4514);
  return match?.[1]?.trim() || rfc4514;
}
