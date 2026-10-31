import { describe, expect, it } from 'vitest';
import type { DiagStep } from '@chef/contracts';
import {
  STEP_ORDER,
  buildReport,
  countByStatus,
  orderSteps,
  overallOf,
  pinAlert,
  type ReportLabels,
} from './diagModel';

function step(id: string, status: DiagStep['status'], over: Partial<DiagStep> = {}): DiagStep {
  return {
    id: id as DiagStep['id'],
    status,
    titleVi: `Tiêu đề ${id}`,
    titleEn: `Title ${id}`,
    detail: `detail ${id}`,
    fixVi: status === 'warn' || status === 'fail' ? `Sửa ${id}` : null,
    fixEn: status === 'warn' || status === 'fail' ? `Fix ${id}` : null,
    ...over,
  };
}

const LABELS: ReportLabels = {
  title: 'Chef PDF: báo cáo chẩn đoán token',
  generatedAt: 'Thời điểm',
  driver: 'Driver',
  overall: { ok: 'Tổng: ổn', warn: 'Tổng: có cảnh báo', fail: 'Tổng: có lỗi' },
  status: { ok: 'Đạt', warn: 'Cảnh báo', fail: 'Lỗi', skipped: 'Bỏ qua' },
  fix: 'Cách sửa',
  noDriver: 'chưa chọn',
};

describe('orderSteps', () => {
  it('sorts by the ladder order regardless of the input order', () => {
    const input = [...STEP_ORDER].reverse().map((id) => step(id, 'ok'));
    expect(orderSteps(input).map((s) => s.id)).toEqual(STEP_ORDER);
  });

  it('puts unknown step ids last, keeping their order', () => {
    const out = orderSteps([
      step('future_b', 'ok'),
      step('driver_found', 'ok'),
      step('future_a', 'ok'),
    ]);
    expect(out.map((s) => s.id)).toEqual(['driver_found', 'future_b', 'future_a']);
  });
});

describe('overallOf and countByStatus', () => {
  it('fail beats warn beats ok; skipped steps do not count', () => {
    expect(overallOf([step('driver_found', 'ok'), step('driver_loads', 'skipped')])).toBe('ok');
    expect(overallOf([step('driver_found', 'ok'), step('pin_state', 'warn')])).toBe('warn');
    expect(overallOf([step('pin_state', 'warn'), step('driver_found', 'fail')])).toBe('fail');
  });

  it('counts each status', () => {
    expect(
      countByStatus([step('a', 'ok'), step('b', 'ok'), step('c', 'skipped'), step('d', 'fail')]),
    ).toEqual({ ok: 2, warn: 0, fail: 1, skipped: 1 });
  });
});

describe('pinAlert', () => {
  it('returns the PIN step when a PIN warning or failure needs attention', () => {
    expect(pinAlert([step('pin_state', 'warn')])?.id).toBe('pin_state');
    expect(pinAlert([step('pin_state', 'fail')])?.id).toBe('pin_state');
  });

  it('returns null when the PIN is fine, skipped or missing', () => {
    expect(pinAlert([step('pin_state', 'ok')])).toBeNull();
    expect(pinAlert([step('pin_state', 'skipped')])).toBeNull();
    expect(pinAlert([step('driver_found', 'ok')])).toBeNull();
  });
});

describe('buildReport', () => {
  const steps = [
    step('driver_found', 'ok', { detail: 'found 1' }),
    step('token_present', 'fail', { detail: 'no token' }),
    step('pin_state', 'warn', { detail: 'flags: none' }),
    step('signing_self_test', 'skipped', { detail: 'skipped: no PIN' }),
  ];

  it('writes one line per step in ladder order with the fix of each problem', () => {
    const report = buildReport({
      steps: [...steps].reverse(),
      overall: 'fail',
      lang: 'vi',
      labels: LABELS,
      modulePath: 'C:\\Windows\\System32\\x.dll',
      generatedAt: '2026-10-31T10:00:00.000Z',
    });
    expect(report).toContain('Chef PDF: báo cáo chẩn đoán token');
    expect(report).toContain('Driver: C:\\Windows\\System32\\x.dll');
    expect(report).toContain('Tổng: có lỗi');
    const order = ['Tiêu đề driver_found', 'Tiêu đề token_present', 'Tiêu đề pin_state'];
    const positions = order.map((s) => report.indexOf(s));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(report).toContain('[Lỗi] Tiêu đề token_present');
    expect(report).toContain('Cách sửa: Sửa token_present');
    expect(report).toContain('[Bỏ qua] Tiêu đề signing_self_test');
    // Ok steps have no fix line.
    expect(report).not.toContain('Sửa driver_found');
  });

  it('uses the English titles and fixes for lang en', () => {
    const report = buildReport({
      steps,
      overall: 'fail',
      lang: 'en',
      labels: { ...LABELS, fix: 'Fix' },
      modulePath: null,
      generatedAt: 'now',
    });
    expect(report).toContain('Title token_present');
    expect(report).toContain('Fix: Fix token_present');
    expect(report).toContain('Driver: chưa chọn');
  });

  it('contains only what the core reports, never a PIN or password', () => {
    const report = buildReport({
      steps: [step('pin_state', 'warn', { detail: 'flags: CKF_USER_PIN_FINAL_TRY' })],
      overall: 'warn',
      lang: 'vi',
      labels: LABELS,
      modulePath: null,
      generatedAt: 'now',
    });
    expect(report).not.toMatch(/mật khẩu|password/i);
  });
});
