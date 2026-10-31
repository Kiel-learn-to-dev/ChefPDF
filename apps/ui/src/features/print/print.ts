import type { PDFDocumentProxy } from 'pdfjs-dist';

const ROOT_ID = 'chef-print-root';

function printRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }
  return root;
}

export function clearPrintRoot() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.querySelectorAll('img').forEach((img) => URL.revokeObjectURL(img.src));
  root.replaceChildren();
}

/**
 * Render `pages` (0-based) at `dpi` into the print-only container (see base.css
 * @media print), then open the OS print dialog via window.print().
 */
export async function printPages(
  pdf: PDFDocumentProxy,
  pages: number[],
  dpi: number,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  clearPrintRoot();
  const root = printRoot();
  const canvas = document.createElement('canvas');
  for (const [i, pageIndex] of pages.entries()) {
    if (signal.aborted) {
      clearPrintRoot();
      return;
    }
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) continue;
    const wrap = document.createElement('div');
    wrap.className = 'print-page';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    await img.decode().catch(() => undefined);
    wrap.appendChild(img);
    root.appendChild(wrap);
    page.cleanup();
    onProgress(i + 1, pages.length);
  }
  canvas.width = canvas.height = 0;
  if (signal.aborted) {
    clearPrintRoot();
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener('afterprint', done);
      resolve();
    };
    window.addEventListener('afterprint', done);
    window.print();
    // Some platforms do not fire afterprint; window.print() is blocking there anyway.
    setTimeout(done, 1000);
  });
  clearPrintRoot();
}
