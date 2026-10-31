import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pngBytesFromDataUrl,
  resolveDefaultSavePath,
  validateAbsPath,
  validateOpenDialogOptions,
  validatePngDataUrl,
  validateRpcCall,
  validateSaveDialogOptions,
} from '../src/main/validate';
import { fitToDisplays, sanitizeWindowState } from '../src/main/windowState';

// 1x1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('validateRpcCall', () => {
  it('accepts dotted method names and normalises params', () => {
    expect(validateRpcCall('system.ping', undefined)).toEqual({
      method: 'system.ping',
      params: {},
    });
    expect(validateRpcCall('ops.run', { opId: 'page.rotate' }).params).toEqual({
      opId: 'page.rotate',
    });
  });

  it('forwards the scan methods (scan.presets is reachable from the renderer)', () => {
    expect(validateRpcCall('scan.presets', {})).toEqual({ method: 'scan.presets', params: {} });
    expect(validateRpcCall('scan.presets', undefined).method).toBe('scan.presets');
    expect(validateRpcCall('ops.run', { opId: 'scan.preview', params: {} }).method).toBe('ops.run');
  });

  it('rejects malformed methods, main-only methods and non-object params', () => {
    for (const m of ['', 'ping', 'System.ping', 'a..b', 'a.b c', 42, 'x.' + 'y'.repeat(200)]) {
      expect(() => validateRpcCall(m, {})).toThrow();
    }
    expect(() => validateRpcCall('system.shutdown', {})).toThrow(/renderer/);
    expect(() => validateRpcCall('a.b', [1])).toThrow(/object/);
    expect(() => validateRpcCall('a.b', 'x')).toThrow(/object/);
    try {
      validateRpcCall('a.b', 1);
    } catch (e) {
      expect(e).toMatchObject({ code: -32602, data: { kind: 'INVALID_PARAMS' } });
    }
  });
});

describe('dialog options', () => {
  it('validates open dialog options', () => {
    expect(validateOpenDialogOptions(undefined)).toEqual({ multiple: false, directory: false });
    expect(validateOpenDialogOptions({ directory: true })).toEqual({
      multiple: false,
      directory: true,
    });
    expect(() => validateOpenDialogOptions({ directory: 1 })).toThrow();
    expect(
      validateOpenDialogOptions({
        multiple: true,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }),
    ).toEqual({
      multiple: true,
      directory: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    expect(() => validateOpenDialogOptions({ multiple: 'yes' })).toThrow();
    expect(() =>
      validateOpenDialogOptions({ filters: [{ name: 'x', extensions: ['../etc'] }] }),
    ).toThrow();
  });

  it('validates save dialog options and resolves default path', () => {
    expect(validateSaveDialogOptions({ defaultPath: 'out.pdf' })).toEqual({
      defaultPath: 'out.pdf',
    });
    expect(() => validateSaveDialogOptions({ defaultPath: 3 })).toThrow();
    const dir = path.resolve('/save');
    expect(resolveDefaultSavePath('out.pdf', dir)).toBe(path.join(dir, 'out.pdf'));
    expect(resolveDefaultSavePath(path.resolve('/abs/out.pdf'), dir)).toBe(
      path.resolve('/abs/out.pdf'),
    );
    expect(resolveDefaultSavePath(undefined, dir)).toBe(dir);
    expect(resolveDefaultSavePath('out.pdf', null)).toBe('out.pdf');
  });

  it('validates absolute paths', () => {
    expect(validateAbsPath(path.resolve('/a/b.pdf'))).toBe(path.resolve('/a/b.pdf'));
    expect(() => validateAbsPath('b.pdf')).toThrow();
    expect(() => validateAbsPath(null)).toThrow();
  });
});

describe('PNG data URLs', () => {
  it('accepts PNG data URLs and checks the signature', () => {
    expect(pngBytesFromDataUrl(validatePngDataUrl(PNG)).length).toBeGreaterThan(8);
    expect(() => validatePngDataUrl('data:image/jpeg;base64,AAAA')).toThrow();
    expect(() => pngBytesFromDataUrl('data:image/png;base64,AAAAAAAAAAAA')).toThrow(/PNG/);
  });
});

describe('window state', () => {
  const screen = [{ x: 0, y: 0, width: 1920, height: 1080 }];

  it('keeps bounds on a visible display and clamps the size', () => {
    expect(fitToDisplays({ x: 100, y: 100, width: 300, height: 200 }, screen)).toEqual({
      x: 100,
      y: 100,
      width: 800,
      height: 560,
    });
  });

  it('drops bounds that are off-screen', () => {
    expect(fitToDisplays({ x: 5000, y: 100, width: 1000, height: 800 }, screen)).toBeNull();
    expect(fitToDisplays({ x: 100, y: -500, width: 1000, height: 800 }, screen)).toBeNull();
    expect(fitToDisplays(null, screen)).toBeNull();
  });

  it('sanitises stored state', () => {
    expect(sanitizeWindowState({ bounds: { x: 'a' }, isMaximized: 1 })).toEqual({
      bounds: null,
      isMaximized: false,
    });
    expect(
      sanitizeWindowState({ bounds: { x: 1, y: 2, width: 3, height: 4 }, isMaximized: true }),
    ).toEqual({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      isMaximized: true,
    });
  });
});
