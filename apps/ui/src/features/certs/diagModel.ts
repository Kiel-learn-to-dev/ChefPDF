/**
 * View-model of the token diagnostic wizard (T3.03, I6, I7). Pure: the caller passes the
 * translated labels, so the report text can be tested and stays in the i18n files.
 */
import type { DiagStatus, DiagStep, DiagStepId } from '@chef/contracts';

/** The fixed ladder of checks, in the order the core runs them. */
export const STEP_ORDER: readonly DiagStepId[] = [
  'driver_found',
  'driver_loads',
  'token_present',
  'token_initialized',
  'certificate_readable',
  'certificate_validity',
  'pin_state',
  'signing_self_test',
];

/** Steps in ladder order. Unknown ids (from a newer core) go last, in their original order. */
export function orderSteps(steps: readonly DiagStep[]): DiagStep[] {
  const rank = (id: string) => {
    const i = STEP_ORDER.indexOf(id as DiagStepId);
    return i === -1 ? STEP_ORDER.length : i;
  };
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => rank(a.step.id) - rank(b.step.id) || a.index - b.index)
    .map(({ step }) => step);
}

export function countByStatus(steps: readonly DiagStep[]): Record<DiagStatus, number> {
  const counts: Record<DiagStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const step of steps) counts[step.status] += 1;
  return counts;
}

/**
 * Overall result: fail beats warn beats ok. Skipped steps do not count. The core sends its own
 * `overall`; this recomputes it so a partial list still gets a sensible banner.
 */
export function overallOf(steps: readonly DiagStep[]): 'ok' | 'warn' | 'fail' {
  const c = countByStatus(steps);
  if (c.fail > 0) return 'fail';
  if (c.warn > 0) return 'warn';
  return 'ok';
}

/**
 * The PIN step when it needs attention (a wrong PIN was recorded, one try is left, locked, or a
 * change is required). Shown as a prominent banner. Null when the PIN state is fine or unknown.
 */
export function pinAlert(steps: readonly DiagStep[]): DiagStep | null {
  const step = steps.find((s) => s.id === 'pin_state');
  if (!step) return null;
  return step.status === 'warn' || step.status === 'fail' ? step : null;
}

/** Title and fix in the chosen language. Falls back to Vietnamese / English when one is empty. */
export function localizedStep(step: DiagStep, lang: 'vi' | 'en') {
  const title = lang === 'vi' ? step.titleVi : step.titleEn;
  const fix = lang === 'vi' ? step.fixVi : step.fixEn;
  return { title, fix: fix ?? null };
}

export interface ReportLabels {
  title: string;
  generatedAt: string;
  driver: string;
  overall: Record<'ok' | 'warn' | 'fail', string>;
  status: Record<DiagStatus, string>;
  fix: string;
  noDriver: string;
}

export interface ReportInput {
  steps: readonly DiagStep[];
  overall: 'ok' | 'warn' | 'fail';
  lang: 'vi' | 'en';
  labels: ReportLabels;
  /** Driver path that was checked, if any. Not a secret. */
  modulePath: string | null;
  /** ISO time of the report. */
  generatedAt: string;
}

/**
 * Plain-text report for support: one line per step, plus the fix of every problem step. It
 * contains only what the core reports (no PIN, no password).
 */
export function buildReport(input: ReportInput): string {
  const { labels, lang } = input;
  const lines: string[] = [
    labels.title,
    `${labels.generatedAt}: ${input.generatedAt}`,
    `${labels.driver}: ${input.modulePath ?? labels.noDriver}`,
    `${labels.overall[input.overall]}`,
    '',
  ];
  for (const step of orderSteps(input.steps)) {
    const { title, fix } = localizedStep(step, lang);
    lines.push(`[${labels.status[step.status]}] ${title}`);
    lines.push(`    ${step.detail}`);
    if (fix && (step.status === 'warn' || step.status === 'fail')) {
      lines.push(`    ${labels.fix}: ${fix}`);
    }
  }
  return lines.join('\n') + '\n';
}
