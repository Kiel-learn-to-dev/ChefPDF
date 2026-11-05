/**
 * The text part of the Sửa chữ mode (D8, D62, D65, D66). One mode holds three things: text is
 * selected by a drag on the line boxes (a double click selects a word), Sửa or Enter opens the
 * selection as a textbox (ParagraphSession), and the Thêm văn bản tool places a new text box where the
 * page is pressed (DraftBox). Presses on the empty page belong to the object layer, which runs with
 * this mode (objects/ObjectLayer.tsx): select, move, arrow keys, Delete.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useViewStore } from '../../app/state/viewer';
import { showError } from '../../app/actions';
import { isEditableTarget } from '../../lib/shortcuts';
import { useEraseState } from '../erase/eraseState';
import { useObjectEdit } from '../objects/objectState';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import type { TextLine } from './textEditModel';
import { paragraphBox } from './textParagraphModel';
import {
  NEW_TEXT_SIZE,
  cancelDraft,
  cancelSession,
  clearSelection,
  commitDraft,
  dragSelection,
  editSelection,
  listPageText,
  loadFonts,
  selectAt,
  textRevisionKey,
} from './textEditActions';
import { useTextEdit, type Draft } from './textEditState';
import { ParagraphSession } from './ParagraphSession';
import { paragraphGlyphs, rangeBoxes } from './textSelection';
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
  // A drag moves the selection only after the press has selected (a textbox may be written first).
  const dragging = useRef(false);
  const dragArmed = useRef(false);
  const active = useTextEdit((s) => s.active);
  const lines = useTextEdit((s) => s.lines);
  const selection = useTextEdit((s) => s.selection);
  const session = useTextEdit((s) => s.session);
  const draft = useTextEdit((s) => s.draft);
  const eraseActive = useEraseState((s) => s.active);
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
  // The line boxes take the mouse when the text part answers a press: a press on text selects it,
  // also with Thêm văn bản on; a press on the empty page places a box (object layer). A signed
  // document leaves the presses to the object layer.
  const boxesLive = live && !blocked;

  // The object layer runs with this mode (one feature, D66). Erase is exclusive with it.
  useEffect(() => {
    useObjectEdit.getState().setActive(active);
    if (active) useEraseState.getState().setActive(false);
  }, [active]);
  useEffect(() => {
    if (eraseActive) useTextEdit.getState().setActive(false);
  }, [eraseActive]);

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

  // Keys of the mode, outside a textbox: Enter opens the selected text, Esc clears the choice.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      const st = useTextEdit.getState();
      if (st.session || st.draft) return;
      if (e.key === 'Escape' && st.addingText) {
        e.preventDefault();
        st.setAddingText(false);
        return;
      }
      if (e.key === 'Escape' && st.selection) {
        e.preventDefault();
        st.setSelection(null);
        return;
      }
      if (e.key === 'Enter' && st.selection && !blocked) {
        e.preventDefault();
        void editSelection(doc.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, doc.id, blocked]);

  // Turning the mode off writes what is open (a textbox, a new text box): the typed text is kept.
  useEffect(() => {
    if (!active) void clearSelection();
  }, [active, doc.id]);

  if (!active) return null;

  const pageOf = (index: number) => pages.find((p) => p.index === index);

  /** A pointer position on the layer, as page index and points; null outside every page. */
  const pointOn = (e: { clientX: number; clientY: number }) => {
    const r = layerRef.current?.getBoundingClientRect();
    if (!r) return null;
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const page = pageAt(pages, x, y);
    if (!page) return null;
    return { page, pt: pagePt(page, { x, y }) };
  };

  const onBoxDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // The box answers the press: the object layer below does not see it. The default focus change
    // is kept off, so the textbox that is open keeps the keyboard.
    e.stopPropagation();
    e.preventDefault();
    const on = pointOn(e);
    if (!on) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // A press on text is not a press on an object: the object selection goes (Shift keeps it).
    if (!e.shiftKey) useObjectEdit.getState().setSelected([]);
    dragging.current = true;
    dragArmed.current = false;
    void selectAt(doc.id, on.page.index, on.pt, { extend: e.shiftKey })
      .then(() => {
        dragArmed.current = dragging.current;
      })
      .catch((err: unknown) => showError(err));
    void loadFonts(doc.id).catch(() => undefined);
  };

  const onBoxMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !dragArmed.current || session) return;
    const sel = useTextEdit.getState().selection;
    const page = sel ? pageOf(sel.pageIndex) : undefined;
    const r = layerRef.current?.getBoundingClientRect();
    if (!page || !r) return;
    dragSelection(pagePt(page, { x: e.clientX - r.left, y: e.clientY - r.top }));
  };

  const endDrag = () => {
    dragging.current = false;
    dragArmed.current = false;
  };

  const onBoxDouble = (e: MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const on = pointOn(e);
    if (!on) return;
    void selectAt(doc.id, on.page.index, on.pt, { word: true });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && session) {
      e.preventDefault();
      cancelSession();
    }
  };

  const sessionPage = session ? pageOf(session.pageIndex) : undefined;
  const sessionLines = session ? (lines[session.pageIndex] ?? []) : [];
  const selectionPage = selection && !session ? pageOf(selection.pageIndex) : undefined;
  const selectionBoxes =
    selection && selectionPage
      ? rangeBoxes(
          paragraphGlyphs(lines[selection.pageIndex] ?? [], selection.paragraphId),
          selection.anchor,
          selection.caret,
        )
      : [];
  const draftPage = draft ? pageOf(draft.pageIndex) : undefined;

  return (
    <div
      ref={layerRef}
      className="tedit-layer"
      onKeyDown={onKeyDown}
      aria-label={t('textEdit.title')}
    >
      {selectionPage &&
        selectionBoxes.map((b, i) => (
          <div
            key={i}
            className="tedit-sel"
            data-testid="tedit-selection"
            style={{
              left: selectionPage.left + b.left * selectionPage.scale,
              top: selectionPage.top + b.top * selectionPage.scale,
              width: b.width * selectionPage.scale,
              height: b.height * selectionPage.scale,
            }}
          />
        ))}
      {pages
        .filter((p) => p.visible)
        .flatMap((p) =>
          (lines[p.index] ?? []).map((line: TextLine) => (
            <div
              key={line.id}
              className={`tedit-box${boxesLive ? ' tedit-box--live' : ''}`}
              data-testid="tedit-box"
              data-text={line.text}
              data-paragraph={line.paragraphId ?? ''}
              onPointerDown={boxesLive ? onBoxDown : undefined}
              onPointerMove={boxesLive ? onBoxMove : undefined}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={boxesLive ? onBoxDouble : undefined}
              style={{
                left: p.left + line.bbox[0]! * p.scale,
                top: p.top + line.bbox[1]! * p.scale,
                width: (line.bbox[2]! - line.bbox[0]!) * p.scale,
                height: (line.bbox[3]! - line.bbox[1]!) * p.scale,
              }}
            />
          )),
        )}
      {/* One dashed outline per editable paragraph (D67); the open textbox has its own frame. */}
      {live &&
        pages
          .filter((p) => p.visible)
          .flatMap((p) => {
            const own = lines[p.index] ?? [];
            const ids = [
              ...new Set(own.map((l) => l.paragraphId).filter((id): id is string => !!id)),
            ];
            return ids
              .filter((id) => id !== session?.paragraphId)
              .map((id) => ({ p, id, box: paragraphBox(own, id) }))
              .filter((o): o is { p: MeasuredPage; id: string; box: number[] } => o.box !== null)
              .map(({ p: page, id, box }) => (
                <div
                  key={`${page.index}:${id}`}
                  className="tedit-para"
                  data-testid="tedit-para"
                  style={{
                    left: page.left + box[0]! * page.scale,
                    top: page.top + box[1]! * page.scale,
                    width: (box[2]! - box[0]!) * page.scale,
                    height: (box[3]! - box[1]!) * page.scale,
                  }}
                />
              ));
          })}
      {session && sessionPage && (
        <ParagraphSession docId={doc.id} page={sessionPage} lines={sessionLines} />
      )}
      {draft && draftPage && <DraftBox page={draftPage} draft={draft} />}
    </div>
  );
}

/**
 * A new text box (Thêm văn bản, D66), typed where the page was pressed. Ctrl+Enter writes it as one
 * overlay text; Esc drops it. A press elsewhere writes it (the object layer's press does that).
 */
function DraftBox({ page, draft }: { page: MeasuredPage; draft: Draft }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  // A new box takes the keyboard in the same commit that shows it: keys typed at once are not lost.
  useLayoutEffect(() => {
    ref.current?.focus();
  }, [draft.pageIndex, draft.x, draft.y]);
  const k = page.scale;
  return (
    <textarea
      ref={ref}
      className="tedit-draft"
      data-testid="tedit-draft"
      aria-label={t('textEdit.draft.label')}
      placeholder={t('textEdit.draft.placeholder')}
      value={draft.text}
      rows={2}
      style={{
        left: page.left + draft.x * k,
        top: page.top + draft.y * k,
        width: 220 * k,
        fontSize: NEW_TEXT_SIZE * k,
      }}
      onChange={(e) => useTextEdit.getState().patchDraft(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void commitDraft();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelDraft();
        }
      }}
    />
  );
}
