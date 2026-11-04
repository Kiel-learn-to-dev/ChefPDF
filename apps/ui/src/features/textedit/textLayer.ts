/**
 * Text layer of the open document (B12, 1.1): the status bar says whether the pages have text to
 * edit, or are a scan. Read again when the document changes (text.layer, read only).
 */
import { useEffect, useState } from 'react';
import type { DocTab } from '../../app/state/documents';
import { runOp } from '../../lib/rpc';
import { i18n } from '../../i18n';

export interface TextLayer {
  pages: number;
  textPages: number;
}

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

/** The label of the text layer, or null when the document has no pages to tell. */
export function textLayerLabel(layer: TextLayer | null): string | null {
  if (!layer || layer.pages === 0) return null;
  if (layer.textPages === layer.pages) return t('status.text.all');
  if (layer.textPages === 0) return t('status.text.none');
  return t('status.text.mixed', { text: layer.textPages, pages: layer.pages });
}

/** The text layer of a document, read again after each change of the document. */
export function useTextLayer(doc: DocTab | undefined): TextLayer | null {
  // The result is keyed by document and version: an old answer is never shown for another one.
  const [known, setKnown] = useState<{ key: string; layer: TextLayer } | null>(null);
  const id = doc?.id;
  const key = id ? `${id}:${doc?.version ?? 0}` : '';
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void runOp('text.layer', {}, { sessionId: id, title: t('status.text.checking'), silent: true })
      .then((result) => {
        if (!cancelled) setKnown({ key, layer: result.data as TextLayer });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, key]);
  return known && known.key === key ? known.layer : null;
}
