/**
 * DEV ONLY: approximate overlay ops for the mock bridge (mockBridge.ts). The real core writes the
 * real output. Standard fonts have no Vietnamese glyphs, so text is drawn as ASCII (diacritics
 * removed). Anchors are approximated as top-left. Overlays are recorded so the overlay manager
 * (F12) works in dev and screenshot mode.
 */
import { PDFDocument, degrees, rgb, StandardFonts, type PDFPage } from 'pdf-lib';
import type { OverlayKind } from '../features/overlay/overlayModel';
import type { OpId, OpParams } from './ops';

export interface MockOverlay {
  id: string;
  kind: OverlayKind;
  group: string;
  pages: number[];
  label: string;
}

/** Text without diacritics: pdf-lib's standard font cannot draw Vietnamese letters. */
export function asciiSafe(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

function hexRgb(hex: string | undefined) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex ?? '');
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1]!, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const MM = 72 / 25.4;
const toPoints = (v: number, unit: string | undefined) => (unit === 'mm' ? v * MM : v);

/** Page indices of a selection (pages, or the pageRange keywords). */
export function mockPages(p: { pages?: number[]; pageRange?: string }, count: number): number[] {
  if (p.pages) return p.pages;
  const all = Array.from({ length: count }, (_, i) => i);
  if (p.pageRange === 'odd') return all.filter((i) => i % 2 === 0);
  if (p.pageRange === 'even') return all.filter((i) => i % 2 === 1);
  return all;
}

function fill(template: string, page: number, pages: number): string {
  return template.replace(/\{page\}/g, String(page + 1)).replace(/\{pages\}/g, String(pages));
}

/** Applies one overlay op to `doc`. Returns the changed pages and the overlay it recorded. */
export async function applyMockOverlay(
  opId: OpId,
  params: unknown,
  doc: PDFDocument,
  readFile: (path: string) => Uint8Array,
  nextId: () => string,
): Promise<{ changed: number[]; overlay: MockOverlay | null }> {
  const count = doc.getPageCount();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const id = nextId();
  const changed = new Set<number>();
  const draw = async (
    pageIndex: number,
    fn: (page: PDFPage, pw: number, ph: number) => Promise<void> | void,
  ) => {
    const page = doc.getPage(pageIndex);
    const { width, height } = page.getSize();
    await fn(page, width, height);
    changed.add(pageIndex);
  };
  const embed = async (path: string) => {
    const bytes = readFile(path);
    return /\.png$/i.test(path) ? doc.embedPng(bytes) : doc.embedJpg(bytes);
  };

  let kind: OverlayKind;
  let label: string;
  switch (opId) {
    case 'overlay.addText': {
      const p = params as OpParams['overlay.addText'];
      kind = 'text';
      label = p.text.slice(0, 40);
      const size = p.fontSize ?? 12;
      const lines = asciiSafe(p.text).split('\n');
      for (const i of mockPages(p, count)) {
        await draw(i, (page, _w, h) => {
          lines.forEach((line, n) =>
            page.drawText(line, {
              x: toPoints(p.x, p.unit),
              y: h - toPoints(p.y, p.unit) - size - n * size * (p.lineHeight ?? 1.2),
              size,
              font: p.bold ? fontBold : font,
              color: hexRgb(p.color),
              opacity: p.opacity ?? 1,
            }),
          );
        });
      }
      break;
    }
    case 'overlay.addImage': {
      const p = params as OpParams['overlay.addImage'];
      kind = 'image';
      label = p.path.split(/[\\/]/).pop() ?? 'image';
      const img = await embed(p.path);
      const w = p.width ?? img.width;
      const h = p.height ?? (w * img.height) / img.width;
      for (const i of mockPages(p, count)) {
        await draw(i, (page, _w, ph) =>
          page.drawImage(img, {
            x: toPoints(p.x, p.unit),
            y: ph - toPoints(p.y, p.unit) - h,
            width: w,
            height: h,
            opacity: p.opacity ?? 1,
          }),
        );
      }
      break;
    }
    case 'overlay.watermark': {
      const p = params as OpParams['overlay.watermark'];
      kind = 'watermark';
      label = p.text ?? 'watermark';
      const img = p.path ? await embed(p.path) : null;
      const text = p.text ? asciiSafe(p.text) : '';
      const size = p.fontSize ?? 60;
      const tw = font.widthOfTextAtSize(text, size);
      for (const i of mockPages(p, count)) {
        await draw(i, (page, pw, ph) => {
          const cells =
            p.mode === 'tiled'
              ? [0.1, 0.5, 0.9].flatMap((fy) => [0.1, 0.5, 0.9].map((fx) => ({ fx, fy })))
              : [{ fx: 0.5, fy: 0.5 }];
          for (const { fx, fy } of cells) {
            const cx = pw * fx;
            const cy = ph * fy;
            if (img) {
              const w = p.width ?? img.width;
              const h = p.height ?? (w * img.height) / img.width;
              page.drawImage(img, {
                x: cx - w / 2,
                y: cy - h / 2,
                width: w,
                height: h,
                rotate: degrees(p.rotation ?? 45),
                opacity: p.opacity ?? 0.25,
              });
            } else {
              page.drawText(text, {
                x: cx - tw / 2,
                y: cy - size / 3,
                size,
                font: p.bold ? fontBold : font,
                color: hexRgb(p.color ?? '#808080'),
                rotate: degrees(p.rotation ?? 45),
                opacity: p.opacity ?? 0.25,
              });
            }
          }
        });
      }
      break;
    }
    case 'stamp.text': {
      const p = params as OpParams['stamp.text'];
      kind = 'stamp';
      const now = new Date();
      const resolved = p.text
        .replace(
          /\{datetime\}/g,
          `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
        )
        .replace(/\{date\}/g, now.toLocaleDateString('en-GB'))
        .replace(
          /\{time\}/g,
          now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        )
        .replace(/\{user\}/g, p.user ?? '');
      const lines = asciiSafe(resolved).split('\n');
      label = lines[0]?.slice(0, 40) ?? 'stamp';
      const size = p.fontSize ?? 24;
      const widest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
      const boxH = lines.length * size * 1.2 + 8;
      for (const i of mockPages(p, count)) {
        await draw(i, (page, _w, h) => {
          const x = toPoints(p.x, p.unit);
          const top = toPoints(p.y, p.unit);
          if ((p.borderWidth ?? 0) > 0) {
            page.drawRectangle({
              x,
              y: h - top - boxH,
              width: widest + 12,
              height: boxH,
              borderColor: hexRgb(p.color),
              borderWidth: p.borderWidth ?? 0,
              opacity: p.opacity ?? 1,
            });
          }
          lines.forEach((line, n) =>
            page.drawText(line, {
              x: x + 6,
              y: h - top - size - 4 - n * size * 1.2,
              size,
              font: p.bold ? fontBold : font,
              color: hexRgb(p.color),
              opacity: p.opacity ?? 1,
            }),
          );
        });
      }
      break;
    }
    case 'stamp.image': {
      const p = params as OpParams['stamp.image'];
      kind = 'stamp';
      label = p.path.split(/[\\/]/).pop() ?? 'stamp';
      const img = await embed(p.path);
      const wPt = toPoints(p.width ?? 40, p.unit);
      const hPt = (wPt * img.height) / img.width;
      for (const i of mockPages(p, count)) {
        await draw(i, (page, _w, ph) =>
          page.drawImage(img, {
            x: toPoints(p.x, p.unit),
            y: ph - toPoints(p.y, p.unit) - hPt,
            width: wPt,
            height: hPt,
            opacity: p.opacity ?? 1,
            rotate: degrees(p.rotation ?? 0),
          }),
        );
      }
      break;
    }
    case 'overlay.headerFooter': {
      const p = params as OpParams['overlay.headerFooter'];
      kind = p.header && Object.values(p.header).some(Boolean) ? 'header' : 'footer';
      label = 'Header/Footer';
      for (const i of mockPages(p, count)) {
        if (p.skipFirst && i === 0) continue;
        await draw(i, (page, pw, ph) => {
          const band = (zones: object | undefined, y: number) => {
            if (!zones) return;
            for (const [zone, tmpl] of Object.entries(zones as Record<string, string>)) {
              if (!tmpl) continue;
              const text = asciiSafe(fill(tmpl, i, count));
              const x =
                zone === 'left'
                  ? 40
                  : zone === 'right'
                    ? pw - 40 - font.widthOfTextAtSize(text, p.fontSize ?? 10)
                    : pw / 2 - font.widthOfTextAtSize(text, p.fontSize ?? 10) / 2;
              page.drawText(text, { x, y, size: p.fontSize ?? 10, font, color: hexRgb(p.color) });
            }
          };
          band(p.header, ph - 30);
          band(p.footer, 20);
        });
      }
      break;
    }
    case 'overlay.pageNumbers': {
      const p = params as OpParams['overlay.pageNumbers'];
      kind = 'number';
      label = 'Số trang';
      const template = p.preset === 'nd30' ? '{page}' : (p.template ?? '{page}');
      const top = p.preset === 'nd30' || (p.position ?? '').startsWith('top');
      for (const i of mockPages(p, count)) {
        if ((p.preset === 'nd30' || p.skipFirst) && i === 0) continue;
        await draw(i, (page, pw, ph) => {
          const text = asciiSafe(fill(template, i, count));
          const size = p.preset === 'nd30' ? 13 : (p.fontSize ?? 12);
          page.drawText(text, {
            x: pw / 2 - font.widthOfTextAtSize(text, size) / 2,
            y: top ? ph - 36 : 24,
            size,
            font,
            color: hexRgb(p.color),
          });
        });
      }
      break;
    }
    case 'overlay.qrCode':
    case 'overlay.barcode': {
      const p = params as OpParams['overlay.qrCode'] & OpParams['overlay.barcode'];
      kind = 'qr';
      label = opId === 'overlay.qrCode' ? 'QR' : 'Mã vạch';
      const size = opId === 'overlay.qrCode' ? toPoints(p.size ?? 25, 'mm') : toPoints(40, 'mm');
      const hgt = opId === 'overlay.qrCode' ? size : toPoints(p.height ?? 15, 'mm');
      for (const i of mockPages(p, count)) {
        await draw(i, (page, _w, ph) => {
          page.drawRectangle({
            x: toPoints(p.x, p.unit ?? 'mm'),
            y: ph - toPoints(p.y, p.unit ?? 'mm') - hgt,
            width: size,
            height: hgt,
            borderColor: rgb(0.4, 0.4, 0.4),
            borderWidth: 0.5,
          });
        });
      }
      break;
    }
    case 'overlay.letterhead': {
      kind = 'letterhead';
      label = 'Giấy tiêu đề';
      // The mock records the letterhead without merging its pages.
      break;
    }
    default:
      throw new Error(`not an overlay op: ${opId}`);
  }

  const pages = [...changed].sort((a, b) => a - b);
  const overlay: MockOverlay | null =
    pages.length || opId === 'overlay.letterhead'
      ? { id, kind, group: `${opId}-${id.slice(-6)}`, pages, label }
      : null;
  return { changed: pages, overlay };
}

/** Standalone overlay.bates for the mock: copies each file and reports the numbering. */
export async function mockBates(
  p: OpParams['overlay.bates'],
  readFile: (path: string) => Uint8Array,
  writeFile: (path: string, bytes: Uint8Array) => void,
): Promise<{ files: Record<string, unknown>[]; outputs: string[]; next: number }> {
  let next = p.startNumber ?? 1;
  const digits = p.digits ?? 6;
  const files: Record<string, unknown>[] = [];
  const outputs: string[] = [];
  for (const f of p.files) {
    const name = f.path.split(/[\\/]/).pop() ?? f.path;
    const doc = await PDFDocument.load(readFile(f.path), { updateMetadata: false });
    const pages = doc.getPageCount();
    const code = (n: number) =>
      `${p.prefix ?? ''}${String(n).padStart(digits, '0')}${p.suffix ?? ''}`;
    const out = p.output ?? { mode: 'suffix' as const };
    const base = f.path.replace(/\.pdf$/i, '');
    const outputPath =
      out.mode === 'folder'
        ? `${out.folder}/${name}`
        : out.mode === 'overwrite'
          ? f.path
          : `${base}${out.suffix ?? '_bates'}.pdf`;
    writeFile(outputPath, await doc.save());
    outputs.push(outputPath);
    files.push({
      path: f.path,
      status: 'done',
      outputPath,
      pages,
      firstLabel: code(next),
      lastLabel: code(next + pages - 1),
      errorKind: null,
      message: null,
      warnings: [],
    });
    next += pages;
  }
  return { files, outputs, next };
}
