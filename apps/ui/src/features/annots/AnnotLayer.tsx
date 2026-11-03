/**
 * Drawing layer of the annotation tools (G2, G3): sticky note (click, then a text box), free text
 * (drag a box, then type), ink (freehand, smoothed) and shapes (drag). While a tool is on the layer
 * takes the mouse; Esc returns to the viewer. Each stroke or box is one annots.* op (a new
 * revision). Text markup comes from the text selection (see annotSelection.ts).
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DocTab } from '../../app/state/documents';
import { isEditableTarget } from '../../lib/shortcuts';
import { measurePages, pageAt, pagePt, type MeasuredPage } from '../objects/pageMeasure';
import { addFreeText, addInk, addNote, addShape } from './annotActions';
import { useAnnotUi } from './annotState';
import './annots.css';

const MIN_BOX_PT = 4;

type Pt = { x: number; y: number };
interface Draft {
  kind: 'note' | 'freetext';
  pageIndex: number;
  /** Layer px of the draft's top-left corner and width (for the editor box). */
  px: { left: number; top: number; width: number };
  /** Note: the anchor point. Free text: the box, [l, t, r, b]. Points, displayed frame. */
  at: Pt;
  rect: number[] | null;
  text: string;
}
interface Gesture {
  page: MeasuredPage;
  start: Pt;
  /** Ink points in page points. */
  pts: Pt[];
  cur: Pt;
  /** Layer px of the points, for the live preview. */
  px: Pt[];
}

export function AnnotLayer({
  doc,
  getContainer,
}: {
  doc: DocTab;
  getContainer(): HTMLElement | null;
}) {
  const { t } = useTranslation();
  const layerRef = useRef<HTMLDivElement>(null);
  const tool = useAnnotUi((s) => s.tool);
  const shape = useAnnotUi((s) => s.shape);
  const color = useAnnotUi((s) => s.color);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const blocked = doc.state.signed;
  const on = tool !== 'none' && !blocked;

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || isEditableTarget(e.target)) return;
      e.preventDefault();
      setDraft(null);
      setGesture(null);
      useAnnotUi.getState().setTool('none');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on]);

  useEffect(() => {
    if (blocked) useAnnotUi.getState().setTool('none');
  }, [blocked]);

  if (!on && !draft) return null;

  const measure = (): MeasuredPage[] => {
    const container = getContainer();
    const layer = layerRef.current;
    return container && layer ? measurePages(container, layer.getBoundingClientRect(), doc) : [];
  };
  const local = (e: RPointerEvent<HTMLDivElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!on || e.button !== 0) return;
    const p = local(e);
    const page = pageAt(measure(), p.x, p.y);
    if (!page) return;
    if (tool === 'note') {
      setDraft({
        kind: 'note',
        pageIndex: page.index,
        at: pagePt(page, p),
        rect: null,
        text: '',
        px: { left: p.x, top: p.y, width: 0 },
      });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = pagePt(page, p);
    setGesture({ page, start, pts: [start], cur: start, px: [p] });
  };

  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!gesture) return;
    const p = local(e);
    const pt = pagePt(gesture.page, p);
    setGesture({
      ...gesture,
      cur: pt,
      pts: tool === 'ink' ? [...gesture.pts, pt] : gesture.pts,
      px: tool === 'ink' ? [...gesture.px, p] : gesture.px,
    });
  };

  const onUp = async () => {
    if (!gesture) return;
    const g = gesture;
    setGesture(null);
    const docId = doc.id;
    if (tool === 'ink') {
      if (g.pts.length > 1) await addInk(docId, g.page.index, [g.pts]);
      return;
    }
    const w = Math.abs(g.cur.x - g.start.x);
    const h = Math.abs(g.cur.y - g.start.y);
    if (tool === 'freetext') {
      if (w < MIN_BOX_PT || h < MIN_BOX_PT) return;
      const rect = [
        Math.min(g.start.x, g.cur.x),
        Math.min(g.start.y, g.cur.y),
        Math.max(g.start.x, g.cur.x),
        Math.max(g.start.y, g.cur.y),
      ];
      const s = g.page.scale;
      setDraft({
        kind: 'freetext',
        pageIndex: g.page.index,
        at: g.start,
        rect,
        text: '',
        px: {
          left: g.page.left + rect[0]! * s,
          top: g.page.top + rect[1]! * s,
          width: (rect[2]! - rect[0]!) * s,
        },
      });
      return;
    }
    if (tool === 'shape' && (w >= MIN_BOX_PT || h >= MIN_BOX_PT)) {
      await addShape(docId, g.page.index, shape, g.start, g.cur);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    const text = draft.text.trim();
    const ok =
      draft.kind === 'note'
        ? await addNote(doc.id, draft.pageIndex, draft.at, text, 'Note')
        : await addFreeText(doc.id, draft.pageIndex, draft.rect ?? [], text);
    if (ok) setDraft(null);
  };

  // The draft box sits where it was drawn (its layer px were taken with the gesture).
  const draftPx = draft ? draft.px : null;

  return (
    <div
      ref={layerRef}
      className={`annot-layer${on ? ' annot-layer--live' : ''}`}
      onPointerDown={on ? onDown : undefined}
      onPointerMove={on ? onMove : undefined}
      onPointerUp={on ? () => void onUp() : undefined}
      role="application"
      aria-label={t(`annots.tool.${tool}`)}
    >
      {gesture && tool === 'ink' && gesture.px.length > 1 && (
        <svg className="annot-layer__ink" aria-hidden="true">
          <polyline
            points={gesture.px.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {gesture && (tool === 'shape' || tool === 'freetext') && (
        <div
          className="annot-layer__band"
          style={boxStyle(gesture.page, gesture.start, gesture.cur)}
        />
      )}
      {draft && draftPx && draft.kind === 'note' && (
        <div className="annot-draft" style={{ left: draftPx.left, top: draftPx.top }}>
          <DraftEditor
            label={t('annots.note.label')}
            value={draft.text}
            onChange={(v) => setDraft({ ...draft, text: v })}
            onSave={() => void saveDraft()}
            onCancel={() => setDraft(null)}
            placeholder={t('annots.note.placeholder')}
          />
        </div>
      )}
      {draft && draftPx && draft.kind === 'freetext' && (
        <div
          className="annot-draft annot-draft--box"
          style={{ left: draftPx.left, top: draftPx.top, width: Math.max(draftPx.width ?? 0, 160) }}
        >
          <DraftEditor
            label={t('annots.freeText.label')}
            value={draft.text}
            onChange={(v) => setDraft({ ...draft, text: v })}
            onSave={() => void saveDraft()}
            onCancel={() => setDraft(null)}
            placeholder={t('annots.freeText.placeholder')}
          />
        </div>
      )}
    </div>
  );
}

function boxStyle(page: MeasuredPage, a: Pt, b: Pt): CSSProperties {
  const l = Math.min(a.x, b.x);
  const tp = Math.min(a.y, b.y);
  return {
    left: page.left + l * page.scale,
    top: page.top + tp * page.scale,
    width: Math.abs(b.x - a.x) * page.scale,
    height: Math.abs(b.y - a.y) * page.scale,
  };
}

function DraftEditor({
  label,
  value,
  onChange,
  onSave,
  onCancel,
  placeholder,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  onSave(): void;
  onCancel(): void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="annot-draft__body" onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        aria-label={label}
        autoFocus
        value={value}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave();
        }}
      />
      <div className="annot-draft__actions">
        <button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" onClick={onSave} disabled={value.trim() === ''}>
          {t('annots.save')}
        </button>
      </div>
    </div>
  );
}
