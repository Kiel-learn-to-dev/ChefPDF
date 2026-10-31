import { describe, expect, it } from 'vitest';
import type { SignatureTemplate } from '@chef/contracts';
import {
  SignRequestError,
  buildSignRequest,
  persistableDraft,
  type SignOptionsDraft,
  type SignerChoice,
} from './signRequest';

const OPTS: SignOptionsDraft = {
  level: 'B-B',
  digest: 'sha256',
  tsaUrls: [],
  reason: '  Phê duyệt  ',
  location: '',
  contact: '',
  certify: 'none',
};

const PLACEMENT = { page: 2, rect: [10, 20, 210, 80] as [number, number, number, number] };

describe('buildSignRequest: certificate file', () => {
  const pfx: SignerChoice = { kind: 'pfx', pfxPath: 'C:/x/ky.pfx', password: 'pw-123' };

  it('builds sign.pades with the visible rect and trimmed reason', () => {
    const req = buildSignRequest(pfx, OPTS, PLACEMENT);
    expect(req.opId).toBe('sign.pades');
    expect(req.params).toEqual({
      pfxPath: 'C:/x/ky.pfx',
      password: 'pw-123',
      level: 'B-B',
      digest: 'sha256',
      reason: 'Phê duyệt',
      page: 2,
      rect: [10, 20, 210, 80],
    });
  });

  it('an invisible signature has no page, rect or field', () => {
    const req = buildSignRequest(pfx, OPTS, null);
    expect(req.params).not.toHaveProperty('page');
    expect(req.params).not.toHaveProperty('rect');
    expect(req.params).not.toHaveProperty('fieldName');
  });

  it('sends the field name when drawing into an existing empty field', () => {
    const req = buildSignRequest(pfx, OPTS, { ...PLACEMENT, fieldName: 'Signature3' });
    expect(req.params).toMatchObject({ fieldName: 'Signature3', page: 2 });
  });

  it('omits the password when none was given', () => {
    const req = buildSignRequest({ kind: 'pfx', pfxPath: 'a.pfx' }, OPTS, null);
    expect(req.params).not.toHaveProperty('password');
  });

  it('passes TSA urls for B-T and above, and certify only when chosen', () => {
    const req = buildSignRequest(
      pfx,
      {
        ...OPTS,
        level: 'B-LT',
        tsaUrls: ['http://tsa.example/a'],
        certify: 'form-fill',
        contact: ' a@b.vn ',
        location: 'Hà Nội',
      },
      null,
    );
    expect(req.params).toMatchObject({
      level: 'B-LT',
      tsaUrls: ['http://tsa.example/a'],
      certify: 'form-fill',
      contactInfo: 'a@b.vn',
      location: 'Hà Nội',
    });
  });

  it('refuses B-T and above without a timestamp server', () => {
    expect(() => buildSignRequest(pfx, { ...OPTS, level: 'B-T' }, null)).toThrow(SignRequestError);
    try {
      buildSignRequest(pfx, { ...OPTS, level: 'B-LTA' }, null);
      expect.fail('should throw');
    } catch (e) {
      expect((e as SignRequestError).code).toBe('NEEDS_TSA');
    }
  });

  it('keeps the template object for the visible look', () => {
    const template: SignatureTemplate = { name: 'Mẫu', layout: 'text-only' };
    const req = buildSignRequest(pfx, { ...OPTS, template }, PLACEMENT);
    expect(req.params).toMatchObject({ template });
  });
});

describe('buildSignRequest: USB token', () => {
  const token: SignerChoice = {
    kind: 'token',
    modulePath: 'C:/driver/eToken.dll',
    slotId: 3,
    certId: 'a1b2',
    pin: '123456',
  };

  it('builds sign.padesToken with slot, cert id and PIN', () => {
    const req = buildSignRequest(token, OPTS, PLACEMENT);
    expect(req.opId).toBe('sign.padesToken');
    expect(req.params).toEqual({
      modulePath: 'C:/driver/eToken.dll',
      slotId: 3,
      certId: 'a1b2',
      pin: '123456',
      level: 'B-B',
      digest: 'sha256',
      reason: 'Phê duyệt',
      page: 2,
      rect: [10, 20, 210, 80],
    });
  });

  it('uses the token serial instead of the slot, and the final-try confirmation', () => {
    const req = buildSignRequest(
      { ...token, slotId: undefined, tokenSerial: 'SN-99', confirmFinalTry: true },
      OPTS,
      null,
    );
    expect(req.params).toMatchObject({ tokenSerial: 'SN-99', confirmFinalTry: true });
    expect(req.params).not.toHaveProperty('slotId');
  });

  it('needs a slot or a serial, a certificate and a PIN', () => {
    expect(() => buildSignRequest({ ...token, slotId: undefined }, OPTS, null)).toThrow(
      SignRequestError,
    );
    expect(() => buildSignRequest({ ...token, certId: '' }, OPTS, null)).toThrow(SignRequestError);
    expect(() => buildSignRequest({ ...token, pin: '' }, OPTS, null)).toThrow(SignRequestError);
  });
});

describe('persistableDraft', () => {
  it('never keeps the PIN', () => {
    const draft = {
      signer: {
        kind: 'token',
        modulePath: 'x.dll',
        certId: 'ab',
        pin: '987654',
        confirmFinalTry: true,
      },
      level: 'B-B',
    };
    const saved = persistableDraft(draft);
    expect(JSON.stringify(saved)).not.toContain('987654');
    expect(saved.signer).toEqual({ kind: 'token', modulePath: 'x.dll', certId: 'ab' });
    // The original object is not changed.
    expect(draft.signer.pin).toBe('987654');
  });

  it('removes a certificate password too', () => {
    const saved = persistableDraft({
      signer: { kind: 'pfx', pfxPath: 'a.pfx', password: 'secret-pw' },
    });
    expect(JSON.stringify(saved)).not.toContain('secret-pw');
    expect(saved.signer).toEqual({ kind: 'pfx', pfxPath: 'a.pfx' });
  });
});
