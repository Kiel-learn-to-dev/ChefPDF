export const MAX_CROP_PIXELS = 50_000_000;
export const MAX_CROP_DIMENSION = 20_000;

export function outputSizeFromMm(widthMm: string, heightMm: string, ppi: number) {
  const widthText = widthMm.trim();
  const heightText = heightMm.trim();
  if (!widthText && !heightText) return { valid: true, outSize: undefined };
  const w = Number(widthText);
  const h = Number(heightText);
  if (
    !Number.isFinite(ppi) ||
    ppi <= 0 ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0
  )
    return { valid: false, outSize: undefined };
  const width = Math.round((w * ppi) / 25.4);
  const height = Math.round((h * ppi) / 25.4);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_CROP_DIMENSION ||
    height > MAX_CROP_DIMENSION ||
    width * height > MAX_CROP_PIXELS
  )
    return { valid: false, outSize: undefined };
  return { valid: true, outSize: [width, height] as [number, number] };
}
