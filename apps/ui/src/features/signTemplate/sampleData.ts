/**
 * Values that fill the lines of a template in the preview. Pure.
 *
 * "Mẫu" mode uses sample values for design. "Chứng thư" mode uses the identity read from a .pfx
 * file (sign.certInfo): the same facts the core would show (I12: the real data is always there).
 */
import type { CertInfoData, SignatureTemplate, TemplateLine } from '@chef/contracts';
import { formatDatePattern } from './templateModel';

export type LineSourceName = TemplateLine['source'];

export interface SignValues {
  signerName: string;
  organization: string;
  taxCode: string;
  citizenId: string;
  reason: string;
  location: string;
  contact: string;
  /** Local date and time when the preview is drawn. */
  signedAt: Date;
}

export const SAMPLE_VALUES: SignValues = {
  signerName: 'Nguyễn Văn An',
  organization: 'Công ty Mẫu',
  taxCode: '0101234567',
  citizenId: '001234567890',
  reason: 'Phê duyệt',
  location: 'Hà Nội',
  contact: 'an.nguyen@example.vn',
  signedAt: new Date(2026, 9, 31, 8, 2, 3),
};

/** Values from a certificate file. Missing facts stay empty (the line then shows only its label). */
export function valuesFromCert(info: CertInfoData, now = new Date()): SignValues {
  return {
    ...SAMPLE_VALUES,
    signerName: info.identity.personName ?? info.subjectCommonName ?? '',
    organization: info.identity.organization ?? '',
    taxCode: info.identity.taxCode ?? '',
    citizenId: info.identity.citizenId ?? '',
    reason: '',
    location: '',
    contact: '',
    signedAt: now,
  };
}

/** The text one source fills in. */
export function sourceValue(
  source: LineSourceName,
  values: SignValues,
  template: SignatureTemplate,
): string {
  switch (source) {
    case 'signerName':
      return values.signerName;
    case 'organization':
      return values.organization;
    case 'taxCode':
      return values.taxCode;
    case 'citizenId':
      return values.citizenId;
    case 'reason':
      return values.reason;
    case 'location':
      return values.location;
    case 'contact':
      return values.contact;
    case 'date':
      return formatDatePattern(
        values.signedAt,
        template.dateFormat ?? 'dd/MM/yyyy HH:mm:ss',
        template.showTimezone ?? false,
      );
    case 'custom':
      return '';
  }
}

export interface PreviewRow {
  text: string;
  fontSize: number;
}

/**
 * The rows the preview draws: the header first, then the enabled lines in list order as
 * "label value". A line's own text replaces the value (custom lines always use their text).
 * Empty rows are skipped.
 */
export function renderRows(template: SignatureTemplate, values: SignValues): PreviewRow[] {
  const size = template.fontSize ?? 9;
  const rows: PreviewRow[] = [];
  if (template.header && template.header.trim()) {
    rows.push({ text: template.header.trim(), fontSize: size });
  }
  for (const line of template.lines ?? []) {
    if (line.enabled === false) continue;
    const override = line.text && line.text.trim() ? line.text : null;
    const value =
      line.source === 'custom'
        ? (override ?? '')
        : (override ?? sourceValue(line.source, values, template));
    const label = line.label?.trim() ?? '';
    const text = [label, value].filter((part) => part.length > 0).join(' ');
    if (text.length === 0) continue;
    rows.push({ text, fontSize: line.fontSize ?? size });
  }
  return rows;
}
