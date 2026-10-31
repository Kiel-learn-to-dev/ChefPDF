import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SignatureTemplate } from '@chef/contracts';
import { chef } from '../../lib/bridge';
import { layoutBox, type PlacedRow } from './canvasLayout';
import type { PreviewRow } from './sampleData';

/** Sample box of the preview in points (about the size of a visible signature). */
export const PREVIEW_BOX = { width: 260, height: 100 } as const;
const SCALE = 2; // device pixels per point
const INSET = 10;

function loadImage(path: string | undefined): Promise<HTMLImageElement | null> {
  if (!path) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = chef().files.toUrl(path);
  });
}

/** Draws the approximate preview. Exported for the studio's proof of concept. */
export function drawApproxPreview(
  ctx: CanvasRenderingContext2D,
  template: SignatureTemplate,
  rows: PreviewRow[],
  images: { image: HTMLImageElement | null; logo: HTMLImageElement | null },
): { overflow: boolean } {
  const W = PREVIEW_BOX.width * SCALE;
  const H = PREVIEW_BOX.height * SCALE;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  const x = INSET;
  const y = INSET;
  const w = PREVIEW_BOX.width - 2 * INSET;
  const h = PREVIEW_BOX.height - 2 * INSET;

  const backgroundAlpha = template.background?.opacity ?? 0;
  if (backgroundAlpha > 0) {
    ctx.globalAlpha = backgroundAlpha;
    ctx.fillStyle = template.background?.color ?? '#FFFFFF';
    ctx.fillRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE);
    ctx.globalAlpha = 1;
  }

  const layout = template.layout ?? 'text-only';
  let textX = x;
  let textW = w;
  const showImage = images.image && template.image;
  if (showImage && (layout === 'image-left' || layout === 'image-right')) {
    const imgW = w * (template.imageRatio ?? 0.35);
    const imgX = layout === 'image-left' ? x : x + w - imgW;
    drawContain(
      ctx,
      images.image!,
      imgX,
      y,
      imgW,
      h,
      template.image!.opacity ?? 1,
      template.image!.fit,
    );
    textW = w - imgW - 4;
    textX = layout === 'image-left' ? x + imgW + 4 : x;
  } else if (showImage && layout === 'image-background') {
    drawContain(
      ctx,
      images.image!,
      x,
      y,
      w,
      h,
      (template.image!.opacity ?? 1) * 0.35,
      template.image!.fit,
    );
  }

  if (images.logo && template.logo) {
    const logoW = Math.min(w * 0.25, h);
    drawContain(
      ctx,
      images.logo,
      x + w - logoW,
      y,
      logoW,
      logoW,
      template.logo.opacity ?? 1,
      template.logo.fit,
    );
    textW -= logoW + 4;
  }

  if (template.checkmark) {
    ctx.strokeStyle = template.checkColor ?? '#1E8E3E';
    ctx.lineWidth = 2 * SCALE;
    ctx.beginPath();
    const cy = y + h / 2;
    ctx.moveTo((textX + 1) * SCALE, cy * SCALE);
    ctx.lineTo((textX + 4) * SCALE, (cy + 3) * SCALE);
    ctx.lineTo((textX + 10) * SCALE, (cy - 4) * SCALE);
    ctx.stroke();
    textX += 14;
    textW -= 14;
  }

  if (template.border) {
    ctx.strokeStyle = template.border.color ?? '#1F3A93';
    ctx.lineWidth = (template.border.width ?? 0.8) * SCALE;
    ctx.strokeRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE);
  }

  const areaW = Math.max(1, textW);
  const layoutResult = layoutBox({ width: areaW, height: h }, template, rows);
  const bold = template.bold ? 'bold ' : '';
  ctx.fillStyle = template.textColor ?? '#000000';
  ctx.textBaseline = 'alphabetic';
  for (const row of layoutResult.rows) drawRow(ctx, row, textX, y, bold);
  return { overflow: layoutResult.overflow };
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  row: PlacedRow,
  boxX: number,
  boxY: number,
  bold: string,
) {
  ctx.font = `${bold}${row.fontSize * SCALE}px "Be Vietnam Pro", sans-serif`;
  ctx.fillText(row.text, (boxX + row.x) * SCALE, (boxY + row.y) * SCALE);
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  opacity: number,
  fit: string | undefined,
) {
  const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
  let dw = w;
  let dh = h;
  if (fit !== 'stretch') {
    const boxRatio = w / h;
    const cover = fit === 'cover';
    if (ratio > boxRatio !== cover) {
      dh = w / ratio;
    } else {
      dw = h * ratio;
    }
  }
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.globalAlpha = opacity;
  ctx.drawImage(img, dx * SCALE, dy * SCALE, dw * SCALE, dh * SCALE);
  ctx.globalAlpha = 1;
}

/** Live preview of the template (approximate, see canvasLayout.ts). */
export function TemplatePreview({
  template,
  rows,
}: {
  template: SignatureTemplate;
  rows: PreviewRow[];
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [images, setImages] = useState<{
    image: HTMLImageElement | null;
    logo: HTMLImageElement | null;
  }>({
    image: null,
    logo: null,
  });
  const [overflow, setOverflow] = useState(false);
  const imagePath = template.image?.path;
  const logoPath = template.logo?.path;

  useEffect(() => {
    let alive = true;
    void Promise.all([loadImage(imagePath), loadImage(logoPath)]).then(([image, logo]) => {
      if (alive) setImages({ image, logo });
    });
    return () => {
      alive = false;
    };
  }, [imagePath, logoPath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const result = drawApproxPreview(ctx, template, rows, images);
    setOverflow(result.overflow);
  }, [template, rows, images]);

  return (
    <figure className="tpl-preview">
      <canvas
        ref={canvasRef}
        className="tpl-preview__canvas"
        width={PREVIEW_BOX.width * SCALE}
        height={PREVIEW_BOX.height * SCALE}
        role="img"
        aria-label={t('tpl.preview.label')}
      />
      <figcaption className="tpl-preview__cap">
        {t('tpl.preview.approx')}
        {overflow && <span className="tpl-preview__warn"> · {t('tpl.preview.overflow')}</span>}
      </figcaption>
    </figure>
  );
}
