/**
 * Paragraph editor (D9, T7.03): a multi-line textarea over the paragraph. Its text is re-flowed by
 * the core only on Apply (text.editParagraph); the style bar (alignment, line spacing, size, bold,
 * italic, colour) can also be applied alone (text.styleParagraph) without changing the text. Overflow
 * and overlapped blocks are reported after the change; the overlapped blocks are highlighted.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { Checkbox, Select, TextInput } from '../../components/Form';
import { ColorInput } from '../overlay/ColorInput';
import { applyParagraph, applyParagraphStyle } from './textEditActions';
import { useTextEdit, type ParaEditor } from './textEditState';
import { canApplyParagraph, hasStyleChange, type ParagraphStyle } from './textParagraphModel';

export function ParagraphEditor({
  docId,
  para,
  box,
}: {
  docId: string;
  para: ParaEditor;
  /** Layer px of the paragraph box: left, top and width. */
  box: { left: number; top: number; width: number };
}) {
  const { t } = useTranslation();
  const style = para.style;
  const setStyle = (patch: Partial<ParagraphStyle>) =>
    useTextEdit.getState().patchParagraph({ style: { ...style, ...patch } });
  const changed = canApplyParagraph(para.original, para.text, style);
  const busy = para.applying;

  return (
    <div
      className="tedit-para"
      style={{ left: box.left, top: box.top, width: Math.max(box.width, 260) }}
      role="dialog"
      aria-label={t('textEdit.para.title')}
    >
      <textarea
        className="tedit-para__text"
        aria-label={t('textEdit.para.text')}
        value={para.text}
        rows={4}
        disabled={busy}
        onChange={(e) => useTextEdit.getState().patchParagraph({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') useTextEdit.getState().closeParagraph();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && changed && !busy) {
            void applyParagraph(docId);
          }
        }}
      />
      <div className="tedit-para__style" role="group" aria-label={t('textEdit.para.style')}>
        <Select<ParagraphStyle['align']>
          aria-label={t('textEdit.para.align')}
          value={style.align}
          onChange={(v) => setStyle({ align: v })}
          options={[
            { value: 'keep', label: t('textEdit.para.keep') },
            { value: 'left', label: t('textEdit.para.alignLeft') },
            { value: 'center', label: t('textEdit.para.alignCenter') },
            { value: 'right', label: t('textEdit.para.alignRight') },
            { value: 'justify', label: t('textEdit.para.alignJustify') },
          ]}
          size="sm"
        />
        <TextInput
          aria-label={t('textEdit.para.lineSpacing')}
          placeholder={t('textEdit.para.lineSpacing')}
          type="number"
          min={1}
          step={0.5}
          value={style.lineSpacing === 'keep' ? '' : String(style.lineSpacing)}
          onChange={(e) => setStyle({ lineSpacing: positiveOrKeep(e.target.value) })}
        />
        <TextInput
          aria-label={t('textEdit.para.size')}
          placeholder={t('textEdit.para.size')}
          type="number"
          min={4}
          step={0.5}
          value={style.fontSize === 'keep' ? '' : String(style.fontSize)}
          onChange={(e) => setStyle({ fontSize: positiveOrKeep(e.target.value) })}
        />
        <Select<'keep' | 'yes' | 'no'>
          aria-label={t('textEdit.para.bold')}
          value={style.bold === 'keep' ? 'keep' : style.bold ? 'yes' : 'no'}
          onChange={(v) => setStyle({ bold: v === 'keep' ? 'keep' : v === 'yes' })}
          options={[
            { value: 'keep', label: t('textEdit.para.boldKeep') },
            { value: 'yes', label: t('textEdit.para.boldOn') },
            { value: 'no', label: t('textEdit.para.boldOff') },
          ]}
          size="sm"
        />
        <Select<'keep' | 'yes' | 'no'>
          aria-label={t('textEdit.para.italic')}
          value={style.italic === 'keep' ? 'keep' : style.italic ? 'yes' : 'no'}
          onChange={(v) => setStyle({ italic: v === 'keep' ? 'keep' : v === 'yes' })}
          options={[
            { value: 'keep', label: t('textEdit.para.italicKeep') },
            { value: 'yes', label: t('textEdit.para.italicOn') },
            { value: 'no', label: t('textEdit.para.italicOff') },
          ]}
          size="sm"
        />
        <Checkbox
          checked={style.color !== 'keep'}
          onChange={(on) => setStyle({ color: on ? '#000000' : 'keep' })}
          label={t('textEdit.para.changeColour')}
        />
        {style.color !== 'keep' && (
          <ColorInput
            label={t('textEdit.para.colour')}
            value={style.color}
            onChange={(v) => setStyle({ color: v })}
          />
        )}
      </div>
      {para.error && (
        <div className="tedit-editor__error" role="alert">
          {para.error}
        </div>
      )}
      <div className="tedit-editor__actions">
        <Button
          variant="ghost"
          onClick={() => useTextEdit.getState().closeParagraph()}
          disabled={busy}
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !hasStyleChange(style)}
          onClick={() => void applyParagraphStyle(docId)}
        >
          {t('textEdit.para.styleOnly')}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !changed}
          onClick={() => void applyParagraph(docId)}
        >
          {t('textEdit.apply')}
        </Button>
      </div>
    </div>
  );
}

/** A positive number, or 'keep' for an empty or invalid field. */
function positiveOrKeep(raw: string): number | 'keep' {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : 'keep';
}
