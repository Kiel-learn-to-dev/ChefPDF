import { describe, expect, it } from 'vitest';
import { DEFAULT_INITIALS_FORM } from '../stamps/initialsModel';
import { DEFAULT_SEAM_FORM } from '../stamps/seamModel';
import { hasStamps, NO_STAMPS, stampStepsOf, withStamps } from './stampSteps';
import {
  buildSignRequest,
  persistableDraft,
  type SignOptionsDraft,
  type SignerChoice,
} from './signRequest';

const OPTIONS: SignOptionsDraft = {
  level: 'B-B',
  digest: 'sha256',
  tsaUrls: [],
  reason: '',
  location: '',
  contact: '',
  certify: 'none',
};
const SEAL = { ...DEFAULT_SEAM_FORM, path: '/tmp/seal.png' };
const INITIALS = { ...DEFAULT_INITIALS_FORM };

const PFX: SignerChoice = { kind: 'pfx', pfxPath: '/tmp/a.pfx', password: 'MAT-KHAU-BI-MAT' };
const TOKEN: SignerChoice = {
  kind: 'token',
  modulePath: '/tmp/p11.dll',
  slotId: 1,
  certId: '01ab',
  pin: '998877',
};

describe('stamp configuration', () => {
  it('has no stamps by default', () => {
    expect(hasStamps(NO_STAMPS)).toBe(false);
    expect(stampStepsOf(NO_STAMPS, 0, 3)).toEqual({ steps: [], problem: null });
  });

  it('builds the seam step before the initials step', () => {
    const { steps, problem } = stampStepsOf({ seam: SEAL, initials: INITIALS }, 0, 3);
    expect(problem).toBeNull();
    expect(steps.map((s) => s.op)).toEqual(['stamp.seam', 'stamp.initials']);
    expect(steps[0]!.params).toMatchObject({ path: '/tmp/seal.png', side: 'right' });
    expect(steps[1]!.params).toMatchObject({ text: 'KN', position: 'bottom-right' });
  });

  it('names the first stamp field that is not valid', () => {
    const { steps, problem } = stampStepsOf(
      { seam: { ...SEAL, path: '' }, initials: INITIALS },
      0,
      3,
    );
    expect(steps).toEqual([]);
    expect(problem).toEqual({ stamp: 'seam', field: 'path' });
    expect(stampStepsOf({ seam: null, initials: { ...INITIALS, text: '' } }, 0, 3).problem).toEqual(
      { stamp: 'initials', field: 'text' },
    );
  });
});

describe('withStamps', () => {
  it('returns a plain request unchanged when there are no stamps', () => {
    const req = buildSignRequest(PFX, OPTIONS, null);
    expect(withStamps(req, [])).toBe(req);
  });

  it('wraps a certificate-file request in sign.stampAndSign', () => {
    const { steps } = stampStepsOf({ seam: SEAL, initials: null }, 0, 3);
    const req = withStamps(buildSignRequest(PFX, OPTIONS, null), steps);
    expect(req.opId).toBe('sign.stampAndSign');
    if (req.opId !== 'sign.stampAndSign') return;
    expect(req.params.stamps).toEqual(steps);
    expect(req.params.sign).toMatchObject({ pfxPath: '/tmp/a.pfx', password: 'MAT-KHAU-BI-MAT' });
  });

  it('wraps a token request in sign.stampAndSignToken', () => {
    const { steps } = stampStepsOf({ seam: null, initials: INITIALS }, 0, 3);
    const req = withStamps(buildSignRequest(TOKEN, OPTIONS, null), steps);
    expect(req.opId).toBe('sign.stampAndSignToken');
    if (req.opId !== 'sign.stampAndSignToken') return;
    expect(req.params.sign).toMatchObject({ modulePath: '/tmp/p11.dll', certId: '01ab' });
  });

  it('keeps the PIN and the password out of the stamp steps', () => {
    const { steps } = stampStepsOf({ seam: SEAL, initials: INITIALS }, 0, 3);
    const pfx = withStamps(buildSignRequest(PFX, OPTIONS, null), steps);
    const token = withStamps(buildSignRequest(TOKEN, OPTIONS, null), steps);
    expect(JSON.stringify((pfx.params as { stamps?: unknown }).stamps)).not.toContain(
      'MAT-KHAU-BI-MAT',
    );
    expect(JSON.stringify((token.params as { stamps?: unknown }).stamps)).not.toContain('998877');
  });

  it('never persists the PIN or the password of a draft that holds stamps', () => {
    const draft = {
      signer: { kind: 'token', modulePath: '/tmp/p11.dll', certId: '01ab', pin: '998877' },
      stamps: { seam: { ...SEAL }, initials: null },
      level: 'B-B',
    };
    const saved = persistableDraft(draft);
    expect(JSON.stringify(saved)).not.toContain('998877');
    expect(saved.stamps.seam?.path).toBe('/tmp/seal.png');
    const pfxDraft = { signer: { kind: 'pfx', pfxPath: '/tmp/a.pfx', password: 'X-SECRET' } };
    expect(JSON.stringify(persistableDraft(pfxDraft))).not.toContain('X-SECRET');
  });
});
