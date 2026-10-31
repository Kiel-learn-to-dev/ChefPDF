/** Formatting helpers (sizes, page sizes, PDF dates). */

export function formatBytes(bytes: number, locale = 'vi'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = u === 0 || v >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v)} ${units[u]}`;
}

const PT_PER_MM = 72 / 25.4;

const PAPER: { name: string; w: number; h: number }[] = [
  { name: 'A3', w: 297, h: 420 },
  { name: 'A4', w: 210, h: 297 },
  { name: 'A5', w: 148, h: 210 },
  { name: 'Letter', w: 215.9, h: 279.4 },
  { name: 'Legal', w: 215.9, h: 355.6 },
];

/** "210 × 297 mm (A4)" for a size in points. */
export function formatPageSize(
  widthPt: number,
  heightPt: number,
  locale = 'vi',
  landscapeLabel = 'landscape',
): string {
  const w = widthPt / PT_PER_MM;
  const h = heightPt / PT_PER_MM;
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const paper = PAPER.find(
    (p) =>
      (Math.abs(p.w - w) < 2 && Math.abs(p.h - h) < 2) ||
      (Math.abs(p.w - h) < 2 && Math.abs(p.h - w) < 2),
  );
  const base = `${nf.format(w)} × ${nf.format(h)} mm`;
  return paper ? `${base} (${paper.name}${w > h ? `, ${landscapeLabel}` : ''})` : base;
}

/** Parse "D:YYYYMMDDHHmmSSOHH'mm'" (PDF date) or ISO strings. */
export function parsePdfDate(value: string): Date | null {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(
    value.trim(),
  );
  if (m && value.trim().startsWith('D:')) {
    const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz, th = '00', tm = '00'] = m;
    let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    if (tz === 'Z' || tz === 'z' || !tz) iso += tz ? 'Z' : '';
    else iso += `${tz}${th}:${tm}`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | Date, locale = 'vi'): string {
  const date = typeof value === 'string' ? parsePdfDate(value) : value;
  if (!date) return typeof value === 'string' ? value : '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** "3 ngày trước"-style relative time. */
export function formatRelative(iso: string, locale = 'vi', now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = (t - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(t));
}
