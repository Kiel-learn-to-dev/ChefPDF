/**
 * Paragraph text editor (D9, T7.03): a multi-line textarea over the paragraph. Its text is re-flowed
 * by the core only on Apply (text.editParagraph). The style is not here: the format bar changes it
 * at once (D14). Overflow and overlapped blocks are reported after the change.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { applyParagraph } from './textEditActions';
import { useTextEdit, type ParaEditor } from './textEditState';
import { canApplyParagraph } from './textParagraphModel';

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
  const changed = canApplyParagraph(para.original, para.text);
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
