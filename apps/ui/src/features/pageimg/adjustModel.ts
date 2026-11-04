import type { PageimgEnhanceParams, PageimgEnhancePreviewParams } from '@chef/contracts';
import { parsePageRanges } from '../../lib/pageRange';

/** The five input levels of the tone curve; the user sets the output at each. */
export const CURVE_INPUTS = [0, 64, 128, 192, 255] as const;

export interface AdjustState {
  whiten: boolean;
  whitenStrength: number;
  denoise: boolean;
  denoiseStrength: number;
  black: number;
  white: number;
  gamma: number;
  curve: number[];
  contrast: number;
  brightness: number;
  invert: boolean;
  grayscale: boolean;
  dpi: string;
  resizePage: boolean;
}

export const DEFAULT_ADJUST: AdjustState = {
  whiten: false,
  whitenStrength: 0.8,
  denoise: false,
  denoiseStrength: 0.5,
  black: 0,
  white: 255,
  gamma: 1,
  curve: CURVE_INPUTS.map((x) => x),
  contrast: 0,
  brightness: 0,
  invert: false,
  grayscale: false,
  dpi: '',
  resizePage: false,
};

export function curveIsDefault(curve: number[]): boolean {
  return curve.every((out, i) => out === CURVE_INPUTS[i]);
}

/** The settings that the operation receives: only what differs from "no change" is sent. */
export function enhanceSettings(state: AdjustState): Omit<PageimgEnhanceParams, 'pages'> {
  const params: Omit<PageimgEnhanceParams, 'pages'> = {};
  if (state.whiten) {
    params.whiten = true;
    params.whitenStrength = state.whitenStrength;
  }
  if (state.denoise) {
    params.denoise = true;
    params.denoiseStrength = state.denoiseStrength;
  }
  if (state.black !== 0 || state.white !== 255 || state.gamma !== 1) {
    params.levels = { black: state.black, white: state.white, gamma: state.gamma };
  }
  if (!curveIsDefault(state.curve)) {
    params.curve = CURVE_INPUTS.map((input, i) => ({ input, output: Math.round(state.curve[i]!) }));
  }
  if (state.contrast) params.contrast = state.contrast;
  if (state.brightness) params.brightness = state.brightness;
  if (state.invert) params.invert = true;
  if (state.grayscale) params.grayscale = true;
  const dpi = Number(state.dpi);
  if (state.dpi.trim() && Number.isInteger(dpi) && dpi >= 50 && dpi <= 1200) {
    params.dpi = dpi;
    if (state.resizePage) params.resizePage = true;
  }
  return params;
}

/** Whether the levels are valid: white must stay above black. */
export function levelsValid(state: AdjustState): boolean {
  return state.white > state.black;
}

export function dpiValid(state: AdjustState): boolean {
  if (!state.dpi.trim()) return true;
  const dpi = Number(state.dpi);
  return Number.isInteger(dpi) && dpi >= 50 && dpi <= 1200;
}

export function applyParams(
  state: AdjustState,
  pagesText: string,
  pageCount: number,
): PageimgEnhanceParams | null {
  if (!levelsValid(state) || !dpiValid(state)) return null;
  const trimmed = pagesText.trim();
  const settings = enhanceSettings(state);
  if (!trimmed) return settings;
  const parsed = parsePageRanges(trimmed, pageCount);
  if (!parsed.ok || parsed.pages.length === 0) return null;
  return { pages: [...parsed.pages].sort((a, b) => a - b), ...settings };
}

export function previewParams(
  state: AdjustState,
  pageIndex: number,
): PageimgEnhancePreviewParams | null {
  if (!levelsValid(state) || !dpiValid(state)) return null;
  // The preview ignores the DPI: it shows the tones and the cleaning only.
  const { dpi: _dpi, resizePage: _resize, ...settings } = enhanceSettings(state);
  void _dpi;
  void _resize;
  return { pageIndex, ...settings };
}

export function parseAdjustPage(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const page = Number(trimmed);
  if (page < 1 || page > pageCount) return null;
  return page - 1;
}
