/**
 * Text edit layer over the viewer (D8, T7.02). In the mode the layer takes the mouse: hover shows
 * the line under the pointer, a click selects it, a double click (or Enter) opens an in-place
 * editor over the line. Typing runs text.checkText (debounced) for the status chip; Enter or
 * Apply runs text.editLine, Esc cancels, Tab moves to the next line. Nothing changes the document
 * until Apply.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type MouseEvent as RMouseEvent,
  type PointerEvent as RPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { useViewStore } from '../../app/state/viewer';
import { showError } from '../../app/actions';
import { toast } from '../../components/Toast';
import { Button } from '../../components/Button';
import { Select } from '../../components/Form';
import { isEditableTarget } from '../../lib/shortcuts';
import { useEraseState } from '../erase/eraseState';
import { useObjectEdit } from '../objects/objectState';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import {
  canApply,
  chipFor,
  createCheckScheduler,
  hitLine,
  isUnchanged,
  lineScreenBox,
  nextLine,
  type CheckScheduler,
  type FitWidth,
  type FontStrategy,
  type TextLine,
} from './textEditModel';
import {
  applyEditor,
  checkLine,
  listPageText,
  loadFonts,
  textRevisionKey,
} from './textEditActions';
import { findLine, useTextEdit } from './textEditState';
import { ParagraphEditor } from './ParagraphEditor';
import { paragraphBox, paragraphText } from './textParagraphModel';
import './textedit.css';

const CHECK_DELAY_MS = 250;
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
  const selectedId = useTextEdit((s) => s.selectedId);
  const editor = useTextEdit((s) => s.editor);
  const fonts = useTextEdit((s) => s.fonts);
  const fitWidth = useTextEdit((s) => s.fitWidth);
  const fontStrategy = useTextEdit((s) => s.fontStrategy);
  const fontName = useTextEdit((s) => s.fontName);
  const eraseActive = useEraseState((s) => s.active);
  const objectActive = useObjectEdit((s) => s.active);
  const paraEditor = useTextEdit((s) => s.paraEditor);
  const selectedParagraphId = useTextEdit((s) => s.selectedParagraphId);
  const tool = useUi((s) => s.tool);
  const rotated = useViewStore((s) => (s.views[doc.id]?.rotation ?? 0) !== 0);
  const blocked = doc.state.signed;
  const cacheKey = textRevisionKey(doc.id);
  const [pages, setPages] = useState<MeasuredPage[]>([]);
  const measureKey = useRef('');
  const scheduler = useRef<CheckScheduler | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleKey = pages
    .filter((p) => p.visible)
    .map((p) => p.index)
    .join(',');
  const live = active && !rotated && !eraseActive && tool === 'select';

  const sched = () => {
    if (!scheduler.current) {
      scheduler.current = createCheckScheduler({
        delayMs: CHECK_DELAY_MS,
        run: (text) => checkLine(doc.id, useTextEdit.getState().editor?.lineId ?? '', text),
        onStart: (seq) => useTextEdit.getState().dispatch({ type: 'checking', seq }),
        onResult: (seq, result) =>
          useTextEdit.getState().dispatch({ type: 'checked', seq, result }),
        onError: (seq) => useTextEdit.getState().dispatch({ type: 'checkFailed', seq }),
      });
    }
    return scheduler.current;
  };

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

  useEffect(() => () => scheduler.current?.cancel(), []);

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
            const { lines: list, blocks } = await listPageText(doc.id, index);
            if (!cancelled) useTextEdit.getState().setPage(cacheKey, index, list, blocks);
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

  const openEditor = (line: TextLine) => {
    if (blocked) {
      toast.warning(t('textEdit.title'), t('overlay.signedBlocked'));
      return;
    }
    if (!line.editable) {
      toast.warning(t('textEdit.title'), t('textEdit.err.TEXT_NOT_EDITABLE'));
      return;
    }
    sched().cancel();
    useTextEdit.getState().setSelected(line.id);
    useTextEdit.getState().dispatch({ type: 'open', line });
    void loadFonts(doc.id).catch(() => undefined);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Keys of the mode (no editor open): capture phase, like the object mode.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]'))
        return;
      const st = useTextEdit.getState();
      if (e.key === 'Escape' && st.selectedId) {
        e.preventDefault();
        st.setSelected(null);
        return;
      }
      if (e.key === 'Enter' && st.selectedId && !st.editor) {
        const line = findLine(st.lines, st.selectedId);
        if (!line) return;
        e.preventDefault();
        openEditor(line);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, doc.id, blocked]);

  const closeEditor = () => {
    sched().cancel();
    useTextEdit.getState().dispatch({ type: 'cancel' });
  };

  const commit = async (): Promise<boolean> => {
    const ed = useTextEdit.getState().editor;
    if (!ed || ed.phase === 'applying') return false;
    if (isUnchanged(lineOf(ed.lineId), ed.text)) {
      closeEditor();
      return true;
    }
    if (!canApply(ed.check)) return false;
    useTextEdit.getState().dispatch({ type: 'apply' });
    const current = useTextEdit.getState().editor;
    if (!current || current.phase !== 'applying') return false;
    return applyEditor(doc.id, current);
  };

  const lineOf = (id: string): TextLine => findLine(useTextEdit.getState().lines, id) ?? emptyLine;

  const moveTo = async (backwards: boolean) => {
    const ed = useTextEdit.getState().editor;
    if (!ed) return;
    const all = Object.values(useTextEdit.getState().lines).flat();
    const target = nextLine(all, ed.lineId, backwards);
    if (!isUnchanged(lineOf(ed.lineId), ed.text)) {
      const ok = await commit();
      if (!ok) return;
    } else {
      closeEditor();
    }
    if (target) openEditor(target);
  };

  if (!active) return null;

  const pageOf = (line: TextLine) => pages.find((p) => p.index === line.pageIndex);
  const hitAt = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const page = pageAt(pages, x, y);
    if (!page) return null;
    const pt = pagePt(page, { x, y });
    return hitLine(useTextEdit.getState().lines[page.index] ?? [], pt.x, pt.y);
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (editor) return;
    const hit = hitAt(e);
    if ((hit?.id ?? null) !== hoverId) useTextEdit.getState().setHover(hit?.id ?? null);
  };

  // Clicks inside an editor belong to the editor (the layer sits under it in the DOM).
  const inEditor = (target: EventTarget | null) =>
    target instanceof Element && target.closest('.tedit-editor, .tedit-para') !== null;

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || inEditor(e.target)) return;
    if (editor) {
      // A click outside the editor ends it: applied when changed and covered, cancelled otherwise.
      void commit();
      return;
    }
    if (paraEditor) return;
    const hit = hitAt(e);
    const st = useTextEdit.getState();
    if (st.paragraphMode || e.altKey) {
      // Paragraph mode (or Alt): the whole paragraph of the line is selected.
      st.setSelectedParagraph(hit?.paragraphId ?? null);
      st.setSelected(hit?.id ?? null);
      return;
    }
    st.setSelectedParagraph(null);
    st.setSelected(hit?.id ?? null);
  };

  const onDoubleClick = (e: RMouseEvent<HTMLDivElement>) => {
    if (editor || paraEditor || inEditor(e.target)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const page = pageAt(pages, e.clientX - r.left, e.clientY - r.top);
    if (!page) return;
    const pt = pagePt(page, { x: e.clientX - r.left, y: e.clientY - r.top });
    const hit = hitLine(useTextEdit.getState().lines[page.index] ?? [], pt.x, pt.y);
    if (!hit) return;
    if (useTextEdit.getState().paragraphMode || e.altKey) {
      if (hit.paragraphId) openParagraph(hit);
      return;
    }
    openEditor(hit);
  };

  /** Opens the paragraph editor on the paragraph of a line (D9). */
  const openParagraph = (line: TextLine) => {
    if (!line.paragraphId) return;
    if (blocked) {
      toast.warning(t('textEdit.title'), t('overlay.signedBlocked'));
      return;
    }
    const pid = line.paragraphId;
    const text = paragraphText(useTextEdit.getState().lines[line.pageIndex] ?? [], pid);
    useTextEdit.getState().setSelectedParagraph(pid);
    useTextEdit.getState().openParagraph({
      pageIndex: line.pageIndex,
      paragraphId: pid,
      original: text,
      text,
    });
    void loadFonts(doc.id).catch(() => undefined);
  };

  const onInputChange = (text: string) => {
    const st = useTextEdit.getState();
    st.dispatch({ type: 'type', text });
    const ed = useTextEdit.getState().editor;
    if (!ed) return;
    if (isUnchanged(lineOf(ed.lineId), text)) {
      sched().cancel();
      return;
    }
    sched().schedule(ed.seq, text);
  };

  const onInputKey = (e: RKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      void moveTo(e.shiftKey);
    }
  };

  const selected = selectedId ? findLine(lines, selectedId) : null;
  const edLine = editor ? lineOf(editor.lineId) : null;
  const edPage = edLine ? pageOf(edLine) : undefined;
  const edBox = edLine && edPage ? lineScreenBox(edLine, edPage) : null;
  const chip = editor && edLine ? chipFor(editor.check, isUnchanged(edLine, editor.text)) : null;
  const applyDisabled =
    !editor ||
    editor.phase === 'applying' ||
    !canApply(editor.check) ||
    (edLine ? isUnchanged(edLine, editor.text) : true);

  return (
    <div
      ref={layerRef}
      className={`tedit-layer${live ? ' tedit-layer--live' : ''}`}
      onPointerMove={live ? onPointerMove : undefined}
      onPointerDown={live ? onPointerDown : undefined}
      onDoubleClick={live ? onDoubleClick : undefined}
      aria-label={t('textEdit.title')}
    >
      {pages
        .filter((p) => p.visible)
        .flatMap((p) =>
          (lines[p.index] ?? []).map((line) => {
            const box = lineScreenBox(line, p);
            const cls = [
              'tedit-box',
              !line.editable || line.artifact ? 'tedit-box--locked' : '',
              line.id === hoverId ? 'tedit-box--hover' : '',
              line.id === selectedId ||
              (selectedParagraphId !== null && line.paragraphId === selectedParagraphId)
                ? 'tedit-box--selected'
                : '',
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
      {!editor && selected && (
        <div className="tedit-hint" role="status">
          {t('textEdit.hintLine')}
        </div>
      )}
      {paraEditor &&
        (() => {
          const pageSpot = pages.find((p) => p.index === paraEditor.pageIndex);
          const box = paragraphBox(lines[paraEditor.pageIndex] ?? [], paraEditor.paragraphId);
          if (!pageSpot || !box) return null;
          return (
            <ParagraphEditor
              docId={doc.id}
              para={paraEditor}
              box={{
                left: pageSpot.left + box[0]! * pageSpot.scale,
                top: pageSpot.top + box[1]! * pageSpot.scale,
                width: (box[2]! - box[0]!) * pageSpot.scale,
              }}
            />
          );
        })()}
      {editor && edLine && edBox && (
        <div
          className="tedit-editor"
          style={{ left: edBox.left, top: edBox.top, minWidth: Math.max(edBox.width, 180) }}
          role="dialog"
          aria-label={t('textEdit.editor')}
        >
          <input
            ref={inputRef}
            className="tedit-editor__input"
            aria-label={t('textEdit.editor')}
            value={editor.text}
            spellCheck={false}
            style={{
              fontSize: edLine.fontSize * (edPage?.scale ?? 1),
              fontWeight: edLine.bold ? 700 : 400,
              fontStyle: edLine.italic ? 'italic' : 'normal',
            }}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onInputKey}
          />
          <div className="tedit-editor__bar">
            {chip && chip.tone !== 'none' && (
              <span className={`tedit-chip tedit-chip--${chip.tone}`} role="status">
                {chip.tone === 'ok' ? '✓ ' : chip.tone === 'warn' ? '⚠ ' : '✗ '}
                {t(`textEdit.chip.${chip.key}`, chip.params)}
              </span>
            )}
            {chip && chip.tone === 'none' && (
              <span className="tedit-chip tedit-chip--none">{t('textEdit.chip.idle')}</span>
            )}
            <Select<FitWidth>
              aria-label={t('textEdit.fit.label')}
              value={fitWidth}
              onChange={(v) => useTextEdit.getState().setOptions({ fitWidth: v })}
              options={[
                { value: 'none', label: t('textEdit.fit.none') },
                { value: 'shrink', label: t('textEdit.fit.shrink') },
                { value: 'track', label: t('textEdit.fit.track') },
              ]}
              size="sm"
            />
            <Select<FontStrategy>
              aria-label={t('textEdit.font.label')}
              value={fontStrategy}
              onChange={(v) => useTextEdit.getState().setOptions({ fontStrategy: v })}
              options={[
                { value: 'auto', label: t('textEdit.font.auto') },
                { value: 'keep', label: t('textEdit.font.keep') },
                { value: 'replace', label: t('textEdit.font.replace') },
              ]}
              size="sm"
            />
            {fontStrategy === 'replace' && fonts && fonts.length > 0 && (
              <Select<string>
                aria-label={t('textEdit.font.pick')}
                value={fontName ?? fonts[0]!.id}
                onChange={(v) => useTextEdit.getState().setOptions({ fontName: v })}
                options={fonts.map((f) => ({
                  value: f.id,
                  label: f.family + (f.bold ? ' Bold' : ''),
                }))}
                size="sm"
              />
            )}
          </div>
          {editor.error && (
            <div className="tedit-editor__error" role="alert">
              {editor.error}
            </div>
          )}
          <div className="tedit-editor__actions">
            <Button variant="ghost" onClick={closeEditor}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={applyDisabled} onClick={() => void commit()}>
              {t('textEdit.apply')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const emptyLine: TextLine = {
  id: '',
  pageIndex: 0,
  text: '',
  bbox: [0, 0, 0, 0],
  fontName: '',
  fontSize: 0,
  bold: false,
  italic: false,
  canEncodeAny: true,
  paragraphId: null,
  editable: false,
  artifact: false,
};
