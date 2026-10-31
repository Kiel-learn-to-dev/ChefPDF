import { describe, expect, it } from 'vitest';
import type { DriverRow } from '@chef/contracts';
import { isSelectable, probeSummary, sortDrivers } from './driverList';

function row(over: Partial<DriverRow>): DriverRow {
  return {
    ca: 'Viettel-CA',
    caId: 'viettel',
    model: 'V6',
    modelId: 'v6',
    path: 'C:\\Windows\\System32\\viettel-ca_v6.dll',
    exists: false,
    confidence: 'documented',
    bitness: '64',
    ...over,
  };
}

describe('sortDrivers', () => {
  it('puts drivers that exist first, then by confidence', () => {
    const rows = [
      row({ ca: 'A', confidence: 'unverified', exists: true }),
      row({ ca: 'B', confidence: 'documented', exists: false }),
      row({ ca: 'C', confidence: 'reported', exists: true }),
      row({ ca: 'D', confidence: 'documented', exists: true }),
    ];
    expect(sortDrivers(rows).map((r) => r.ca)).toEqual(['D', 'C', 'A', 'B']);
  });

  it('breaks ties by CA name, then model, then path', () => {
    const rows = [
      row({ ca: 'VNPT-CA', model: 'v8', path: 'z' }),
      row({ ca: 'FPT-CA', model: 'v5', path: 'b' }),
      row({ ca: 'FPT-CA', model: 'v2', path: 'a' }),
    ];
    expect(sortDrivers(rows).map((r) => `${r.ca}/${r.model}`)).toEqual([
      'FPT-CA/v2',
      'FPT-CA/v5',
      'VNPT-CA/v8',
    ]);
  });

  it('does not mutate its input', () => {
    const rows = [row({ ca: 'B', exists: false }), row({ ca: 'A', exists: true })];
    const copy = [...rows];
    sortDrivers(rows);
    expect(rows).toEqual(copy);
  });
});

describe('probeSummary', () => {
  it('is none when the driver was not probed', () => {
    expect(probeSummary(undefined)).toEqual({ kind: 'none' });
  });

  it('lists token labels of a loaded driver', () => {
    expect(
      probeSummary({ status: 'ok', errorKind: null, reason: null, tokenLabels: ['TOKEN 1'] }),
    ).toEqual({ kind: 'labels', labels: ['TOKEN 1'] });
  });

  it('reports a load error', () => {
    expect(
      probeSummary({
        status: 'error',
        errorKind: 'TOKEN_DRIVER_ERROR',
        reason: 'C_Initialize failed',
        tokenLabels: [],
      }),
    ).toEqual({ kind: 'error', errorKind: 'TOKEN_DRIVER_ERROR', reason: 'C_Initialize failed' });
  });
});

describe('isSelectable', () => {
  it('only drivers present on this computer can be chosen', () => {
    expect(isSelectable(row({ exists: true }))).toBe(true);
    expect(isSelectable(row({ exists: false }))).toBe(false);
  });
});
