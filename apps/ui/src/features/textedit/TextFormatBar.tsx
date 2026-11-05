/**
 * Format bar (D14, 1.1): a fixed row under the PDF toolbar while the text edit mode is on. It shows
 * the format of the selected paragraph and applies each change at once, one revision per change
 * (Ctrl+Z undoes one change). With no paragraph selected the row keeps its place with the controls
 * off, so the page does not jump.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bold, Italic, Minus, Plus } from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { Button } from '../../components/Button';
import { Select, TextInput } from '../../components/Form';
import { applyFormat, loadFonts } from './textEditActions';
import { useTextEdit } from './textEditState';
import './textedit.css';
import {
  currentFormat,
  pageOfParagraph,
  paragraphText,
  reselectParagraph,
  type ParagraphStyle,
} from './textParagraphModel';

type Align = 'left' | 'center' | 'right' | 'justify';
const ALIGNS: Align[] = ['left', 'center', 'right', 'justify'];

/** Colour of the native picker: the change is applied on blur, not on each drag step. */

export function TextFormatBar({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const active = useTextEdit((s) => s.active);
  const pid = useTextEdit((s) => s.selectedParagraphId);
  const lines = useTextEdit((s) => s.lines);
  const paragraphs = useTextEdit((s) => s.paragraphs);
  const busy = useTextEdit((s) => s.formatBusy);
  const fonts = useTextEdit((s) => s.fonts);
  const openDialog = useUi((s) => s.openDialog);
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [indentDraft, setIndentDraft] = useState<string | null>(null);
  const [colourDraft, setColourDraft] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState<string | null>(null);

  const page = pid ? pageOfParagraph(pid) : null;
  const fmt =
    pid !== null && page !== null
      ? currentFormat(lines[page] ?? [], paragraphs[page] ?? [], pid)
      : null;
  const locked = !fmt || busy || doc.state.signed;

  useEffect(() => {
    if (active) void loadFonts(doc.id).catch(() => undefined);
  }, [active, doc.id]);

  // Undo and redo make a new revision, so the id of the selected paragraph can go stale. Once the
  // page is read again, select the paragraph at the same position (no centre: the lines are gone).
  useEffect(() => {
    if (pid === null || page === null) return;
    const pageLines = lines[page];
    if (!pageLines || pageLines.some((l) => l.paragraphId === pid)) return;
    useTextEdit.getState().setSelectedParagraph(reselectParagraph(pageLines, pid, null));
  }, [pid, page, lines]);

  if (!active) return null;

  const change = (patch: Partial<ParagraphStyle>, fontName: string | null = null) => {
    if (pid) void applyFormat(doc.id, patch, fontName);
  };

  const commitSize = () => {
    const n = Number(sizeDraft);
    setSizeDraft(null);
    if (fmt && sizeDraft !== null && n > 0 && n !== fmt.fontSize) change({ fontSize: n });
  };

  const commitIndent = () => {
    const n = Number(indentDraft);
    setIndentDraft(null);
    if (fmt && indentDraft !== null && indentDraft.trim() !== '' && n >= 0 && n !== fmt.indent) {
      change({ indent: n });
    }
  };

  const editText = () => {
    if (!fmt || pid === null || page === null) return;
    const text = paragraphText(lines[page] ?? [], pid);
    useTextEdit
      .getState()
      .openParagraph({ pageIndex: page, paragraphId: pid, original: text, text });
  };

  // Line spacing is not read back (getLines has no pitch), so the field is empty: it means keep.
  const commitLineSpacing = () => {
    const raw = lineDraft;
    setLineDraft(null);
    const n = Number(raw);
    if (fmt && raw !== null && raw.trim() !== '' && n > 0) change({ lineSpacing: n });
  };

  const commitColour = () => {
    const c = colourDraft;
    setColourDraft(null);
    if (fmt && c !== null && c.toLowerCase() !== (fmt.colour ?? '#000000').toLowerCase()) {
      change({ color: c });
    }
  };

  const align: Align | 'none' =
    fmt && (ALIGNS as string[]).includes(fmt.align) ? (fmt.align as Align) : 'none';

  return (
    <div className="tedit-fmt" role="toolbar" aria-label={t('textEdit.fmt.label')}>
      <Button
        size="sm"
        variant="ghost"
        disabled={doc.state.signed}
        onClick={() => openDialog('overlayText')}
      >
        {t('textEdit.fmt.addText')}
      </Button>
      <Select<string>
        aria-label={t('textEdit.fmt.font')}
        value="pick"
        onChange={(v) => v !== 'pick' && change({}, v)}
        options={[
          { value: 'pick', label: t('textEdit.fmt.font') },
          ...(fonts ?? []).map((f) => ({ value: f.id, label: f.family + (f.bold ? ' Bold' : '') })),
        ]}
        size="sm"
        disabled={locked}
      />
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('textEdit.fmt.smaller')}
        disabled={locked}
        onClick={() => fmt && change({ fontSize: Math.max(fmt.fontSize - 1, 1) })}
      >
        <Minus size={14} aria-hidden />
      </Button>
      <TextInput
        size="sm"
        aria-label={t('textEdit.para.size')}
        type="number"
        min={1}
        step={0.5}
        disabled={locked}
        value={sizeDraft ?? (fmt ? String(fmt.fontSize) : '')}
        onChange={(e) => setSizeDraft(e.target.value)}
        onBlur={commitSize}
        onKeyDown={(e) => e.key === 'Enter' && commitSize()}
      />
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('textEdit.fmt.bigger')}
        disabled={locked}
        onClick={() => fmt && change({ fontSize: fmt.fontSize + 1 })}
      >
        <Plus size={14} aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('textEdit.para.bold')}
        aria-pressed={fmt?.bold ?? false}
        disabled={locked}
        onClick={() => fmt && change({ bold: !fmt.bold })}
      >
        <Bold size={14} aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t('textEdit.para.italic')}
        aria-pressed={fmt?.italic ?? false}
        disabled={locked}
        onClick={() => fmt && change({ italic: !fmt.italic })}
      >
        <Italic size={14} aria-hidden />
      </Button>
      <Select<Align | 'none'>
        aria-label={t('textEdit.para.align')}
        value={align}
        onChange={(v) => v !== 'none' && change({ align: v })}
        options={[
          { value: 'none', label: t('textEdit.fmt.alignNone') },
          { value: 'left', label: t('textEdit.para.alignLeft') },
          { value: 'center', label: t('textEdit.para.alignCenter') },
          { value: 'right', label: t('textEdit.para.alignRight') },
          { value: 'justify', label: t('textEdit.para.alignJustify') },
        ]}
        size="sm"
        disabled={locked}
      />
      <TextInput
        size="sm"
        aria-label={t('textEdit.fmt.indent')}
        title={t('textEdit.fmt.indent')}
        type="number"
        min={0}
        step={1}
        disabled={locked}
        value={indentDraft ?? (fmt ? String(fmt.indent) : '')}
        onChange={(e) => setIndentDraft(e.target.value)}
        onBlur={commitIndent}
        onKeyDown={(e) => e.key === 'Enter' && commitIndent()}
      />
      <TextInput
        size="sm"
        aria-label={t('textEdit.fmt.lineSpacing')}
        title={t('textEdit.fmt.lineSpacing')}
        placeholder={t('textEdit.fmt.lineSpacing')}
        type="number"
        min={1}
        step={0.5}
        disabled={locked}
        value={lineDraft ?? ''}
        onChange={(e) => setLineDraft(e.target.value)}
        onBlur={commitLineSpacing}
        onKeyDown={(e) => e.key === 'Enter' && commitLineSpacing()}
      />
      <input
        type="color"
        className="ov-color__swatch"
        aria-label={t('textEdit.para.colour')}
        title={t('textEdit.para.colour')}
        disabled={locked}
        value={colourDraft ?? fmt?.colour ?? '#000000'}
        onChange={(e) => setColourDraft(e.target.value)}
        onBlur={commitColour}
      />
      <Button size="sm" variant="secondary" disabled={locked} onClick={editText}>
        {t('textEdit.fmt.editText')}
      </Button>
      {!pid && <span className="tedit-fmt__hint">{t('textEdit.fmt.pick')}</span>}
    </div>
  );
}
