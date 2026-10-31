/** View model of the trust store dialog (I35). Pure. */
import type { TrustEntry } from '@chef/contracts';

export type TrustGroup = TrustEntry['group'];

export const TRUST_GROUPS: readonly TrustGroup[] = ['vn-public-ca', 'vn-gov-ca', 'user'];

/** i18n key of a group name. */
export function groupLabelKey(group: TrustGroup): string {
  return `sig.trust.group.${group === 'vn-public-ca' ? 'publicCa' : group === 'vn-gov-ca' ? 'govCa' : 'user'}`;
}

/** Only certificates the user added can be removed; the bundled roots stay. */
export function canRemove(entry: TrustEntry): boolean {
  return entry.source === 'user';
}

const GROUP_RANK: Record<TrustGroup, number> = { 'vn-public-ca': 0, 'vn-gov-ca': 1, user: 2 };

/** Bundled roots first (by group), then the user's, each by subject. */
export function sortTrust(entries: readonly TrustEntry[]): TrustEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(a.source === 'user') - Number(b.source === 'user') ||
      GROUP_RANK[a.group] - GROUP_RANK[b.group] ||
      a.subject.localeCompare(b.subject),
  );
}

/** Expiry date of a root as dd/mm/yyyy, or the raw value when it is not a date. */
export function expiryText(notAfter: string, timeZone?: string): string {
  const date = new Date(notAfter);
  if (Number.isNaN(date.getTime())) return notAfter;
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** True when the root expires within `days` days of `now` (or has expired). */
export function expiresWithin(notAfter: string, days: number, now: Date): boolean {
  const end = Date.parse(notAfter);
  if (Number.isNaN(end)) return false;
  return end - now.getTime() <= days * 24 * 60 * 60 * 1000;
}
