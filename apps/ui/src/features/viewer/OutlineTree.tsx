import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ListTree } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { EmptyState, Spinner } from '../../components/Misc';
import { usePdfDocument } from './pdfCache';
import { getViewer } from './controllers';

export interface OutlineNode {
  title: string;
  dest: unknown;
  url?: string | null;
  items: OutlineNode[];
}

function OutlineItem({ node, docId, depth }: { node: OutlineNode; docId: string; depth: number }) {
  const [open, setOpen] = useState(depth === 0 && node.items.length < 12);
  const hasChildren = node.items.length > 0;
  return (
    <li role="treeitem" aria-expanded={hasChildren ? open : undefined} aria-level={depth + 1}>
      <div className="outline__row" style={{ paddingLeft: 4 + depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            className="outline__toggle"
            aria-label={node.title}
            tabIndex={-1}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
          </button>
        ) : (
          <span className="outline__toggle" />
        )}
        <button
          type="button"
          className="outline__title"
          title={node.title}
          onClick={() => node.dest && getViewer(docId)?.goToDest(node.dest)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && hasChildren) setOpen(true);
            if (e.key === 'ArrowLeft' && hasChildren) setOpen(false);
          }}
        >
          {node.title}
        </button>
      </div>
      {hasChildren && open && (
        <ul role="group">
          {node.items.map((c, i) => (
            <OutlineItem key={i} node={c} docId={docId} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OutlineTree({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const { pdf } = usePdfDocument(doc);
  const [outline, setOutline] = useState<OutlineNode[] | null | undefined>(undefined);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    pdf
      .getOutline()
      .then((o) => !cancelled && setOutline((o as OutlineNode[] | null) ?? null))
      .catch(() => !cancelled && setOutline(null));
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  if (outline === undefined)
    return (
      <div className="sidenav__center">
        <Spinner />
      </div>
    );
  if (!outline || outline.length === 0)
    return (
      <EmptyState
        icon={<ListTree size={22} />}
        title={t('sidebar.noOutline')}
        text={t('sidebar.noOutlineText')}
      />
    );
  return (
    <ul className="outline" role="tree" aria-label={t('sidebar.outline')}>
      {outline.map((n, i) => (
        <OutlineItem key={i} node={n} docId={doc.id} depth={0} />
      ))}
    </ul>
  );
}
