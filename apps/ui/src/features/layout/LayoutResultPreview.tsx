import { createElement } from 'react';
import { useTranslation } from 'react-i18next';
import { reviewedBlock, type Change, type Page } from './reviewModel';

interface Props {
  page: Page;
  changes: Change[];
  selectedBlock: number | null;
  onSelectBlock: (index: number) => void;
}

export function LayoutResultPreview({ page, changes, selectedBlock, onSelectBlock }: Props) {
  const { t } = useTranslation();
  return (
    <section className="layout-review__result" aria-label={t('layoutReview.result')}>
      <h3>{t('layoutReview.result')}</h3>
      <p className="layout-review__preview-note">{t('layoutReview.previewNote')}</p>
      <article className="layout-review__paper">
        {page.blocks.map((block, index) => {
          const preview = reviewedBlock(block, changes, page.index, index);
          const selected = selectedBlock === index;
          const common = {
            key: index,
            className: `layout-review__preview-block${selected ? ' is-selected' : ''}`,
            'aria-pressed': selected,
            onClick: () => onSelectBlock(index),
            type: 'button' as const,
          };
          if (
            preview.kind === 'header' ||
            preview.kind === 'footer' ||
            preview.kind === 'pageNumber'
          )
            return null;
          if (preview.kind === 'heading') {
            const headingTag = `h${Math.min(6, Math.max(1, preview.level))}`;
            return (
              <button {...common}>
                {createElement(headingTag, null, preview.text || t('layoutReview.nonText'))}
              </button>
            );
          }
          if (preview.kind === 'list')
            return (
              <button {...common}>
                <ul>
                  <li>{preview.text || t('layoutReview.listPreview')}</li>
                </ul>
              </button>
            );
          if (['paragraph', 'footnote', 'unknown'].includes(preview.kind))
            return (
              <button {...common}>
                <p>{preview.text || t('layoutReview.nonText')}</p>
              </button>
            );
          return (
            <button {...common}>
              <p className="layout-review__preview-placeholder">
                {t(`layoutReview.kinds.${preview.kind}`, { defaultValue: preview.kind })}
              </p>
            </button>
          );
        })}
        {page.blocks.length === 0 && <p>{t('layoutReview.emptyPage')}</p>}
      </article>
    </section>
  );
}
