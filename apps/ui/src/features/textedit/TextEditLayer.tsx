/**
 * Text edit layer over the viewer (D8, D62). In the mode the layer takes the mouse: hover shows the
 * line under the pointer, and a click on text opens a paragraph session with the caret where the
 * click was. A click elsewhere writes the open session. The session itself is ParagraphSession.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useViewStore } from '../../app/state/viewer';
import { showError } from '../../app/actions';
import { toast } from '../../components/Toast';
import { isEditableTarget } from '../../lib/shortcuts';
import { useEraseState } from '../erase/eraseState';
import { useObjectEdit } from '../objects/objectState';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import { hitLine, lineScreenBox, type TextLine } from './textEditModel';
import {
  cancelSession,
  commitSession,
  listPageText,
  loadFonts,
  openSessionAt,
  startSession,
  textRevisionKey,
} from './textEditActions';
import { useTextEdit } from './textEditState';
import { ParagraphSession } from './ParagraphSession';
import { paragraphLines, pageOfParagraph } from './textParagraphModel';
import './textedit.css';

const LOAD_DELAY_MS = 120;

export function TextEditLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const active = useTextEdit((s) => s.active);
  const lines = useTextEdit((s) => s.lines);
  const hoverId = useTextEdit((s) => s.hoverId);
  const selectedParagraphId = useTextEdit((s) => s.selectedParagraphId);
  const session = useTextEdit((s) => s.session);
  const eraseActive = useEraseState((s) => s.active);
  const objectActive = useObjectEdit((s) => s.active);
  const tool = useUi((s) => s.tool);
  const rotated = useViewStore((s) => (s.views[doc.id]?.rotation ?? 0) !== 0);
  const blocked = doc.state.signed;
  const cacheKey = textRevisionKey(doc.id);
  const [pages, setPages] = useState<MeasuredPage[]>([]);
  const measureKey = useRef('');
  const visibleKey = pages
    .filter((p) => p.visible)
    .map((p) => p.index)
    .join(',');
  const live = active && !rotated && !eraseActive && tool === 'select';

  // The object and erase modes are exclusive with this one (whichever is switched on last wins).
  useEffect(() => {
    if (!active) return;
    useObjectEdit.getState().setActive(false);
    useEraseState.getState().setActive(false);
  }, [active]);
  useEffect(() => {
    if (objectActive || eraseActive) useTextEdit.getState().setActive(false);
  }, [objectActive, eraseActive]);

  // A new revision (or document) starts with an empty line cache.
  useEffect(() => {
    useTextEdit.getState().resetFor(cacheKey);
  }, [cacheKey]);

  const remeasure = () => {
    const container = getContainer();
    const layer = layerRef.current;
    if (!container || !layer) return;
    const next = measurePages(container, layer.getBoundingClientRect(), doc);
    const k = JSON.stringify(next);
    if (k !== measureKey.current) {
      measureKey.current = k;
      setPages(next);
    }
  };

  useLayoutEffect(() => {
    if (active) remeasure();
  });

  useEffect(() => {
    if (!active) return;
    const container = getContainer();
    if (!container) return;
    container.addEventListener('scroll', remeasure, { passive: true });
    window.addEventListener('resize', remeasure);
    const ro = new ResizeObserver(remeasure);
    ro.observe(container);
    return () => {
      container.removeEventListener('scroll', remeasure);
      window.removeEventListener('resize', remeasure);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc.id]);

  // Lines of the visible pages, for the current revision (debounced).
  useEffect(() => {
    if (!active) return;
    const wanted = visibleKey ? visibleKey.split(',').map(Number) : [];
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const index of wanted) {
          if (cancelled) return;
          const st = useTextEdit.getState();
          if (st.key !== cacheKey) return;
          if (st.lines[index]) continue;
          try {
            const { lines: list, blocks, paragraphs } = await listPageText(doc.id, index);
            if (!cancelled)
              useTextEdit.getState().setPage(cacheKey, index, list, blocks, paragraphs);
          } catch (e) {
            if (!cancelled) showError(e);
            return;
          }
        }
      })();
    }, LOAD_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, cacheKey, visibleKey, doc.id]);

  // Keys of the mode, outside a session: Enter opens the selected paragraph, Esc clears the choice.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      const st = useTextEdit.getState();
      if (st.session) return;
      if (e.key === 'Escape' && st.selectedParagraphId) {
        e.preventDefault();
        st.setSelectedParagraph(null);
        return;
      }
      if (e.key === 'Enter' && st.selectedParagraphId) {
        const pid = st.selectedParagraphId;
        const page = pageOfParagraph(pid);
        if (page === null || blocked) return;
        e.preventDefault();
        void startSession(doc.id, page, pid);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, doc.id, blocked]);

  if (!active) return null;

  const pageOf = (index: number) => pages.find((p) => p.index === index);

  /** A pointer position on the page: page index and points, or null outside every page. */
  const pointOn = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const page = pageAt(pages, x, y);
    if (!page) return null;
    const pt = pagePt(page, { x, y });
    return { page, pt };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (session) return;
    const on = pointOn(e);
    const hit = on
      ? hitLine(useTextEdit.getState().lines[on.page.index] ?? [], on.pt.x, on.pt.y)
      : null;
    if ((hit?.id ?? null) !== hoverId) useTextEdit.getState().setHover(hit?.id ?? null);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Keep the focus where the session put it: a default focus change would blur the input and
    // write the session at once.
    e.preventDefault();
    const on = pointOn(e);
    if (!on) {
      // A click on the page margin writes the session and clears the choice.
      if (session) void commitSession(doc.id);
      useTextEdit.getState().setSelectedParagraph(null);
      return;
    }
    if (blocked) {
      toast.warning(t('textEdit.title'), t('overlay.signedBlocked'));
      return;
    }
    const line = hitLine(useTextEdit.getState().lines[on.page.index] ?? [], on.pt.x, on.pt.y);
    if (!line?.paragraphId) {
      if (session) void commitSession(doc.id);
      useTextEdit.getState().setSelectedParagraph(null);
      return;
    }
    void loadFonts(doc.id).catch(() => undefined);
    void openSessionAt(doc.id, on.page.index, on.pt).catch((err: unknown) => showError(err));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && session) {
      e.preventDefault();
      cancelSession();
    }
  };

  const sessionPage = session ? pageOf(session.pageIndex) : undefined;
  const sessionLines = session ? (lines[session.pageIndex] ?? []) : [];
  const selectedLines: TextLine[] = selectedParagraphId
    ? paragraphLines(lines[pageOfParagraph(selectedParagraphId) ?? -1] ?? [], selectedParagraphId)
    : [];

  return (
    <div
      ref={layerRef}
      className={`tedit-layer${live ? ' tedit-layer--live' : ''}`}
      onPointerMove={live ? onPointerMove : undefined}
      onPointerDown={live ? onPointerDown : undefined}
      onKeyDown={onKeyDown}
      aria-label={t('textEdit.title')}
    >
      {pages
        .filter((p) => p.visible)
        .flatMap((p) =>
          (lines[p.index] ?? []).map((line) => {
            const box = lineScreenBox(line, p);
            const onSelected =
              selectedParagraphId !== null && line.paragraphId === selectedParagraphId;
            const cls = [
              'tedit-box',
              !line.editable || line.artifact ? 'tedit-box--locked' : '',
              line.id === hoverId ? 'tedit-box--hover' : '',
              onSelected ? 'tedit-box--selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <div
                key={line.id}
                className={cls}
                data-testid="tedit-box"
                data-text={line.text}
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                title={line.canEncodeAny ? undefined : t('textEdit.noGlyphs')}
              />
            );
          }),
        )}
      {session && sessionPage && (
        <ParagraphSession docId={doc.id} page={sessionPage} lines={sessionLines} />
      )}
      {!session && selectedLines.length > 0 && (
        <div className="tedit-hint" role="status">
          {t('textEdit.session.enter')}
        </div>
      )}
    </div>
  );
}
