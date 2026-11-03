import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanText } from 'lucide-react';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { showError } from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog, DialogSpacer } from '../../components/Dialog';
import { Select } from '../../components/Form';
import { runOp } from '../../lib/rpc';
import { usePdfDocument } from '../viewer/pdfCache';
import { renderPageToCanvas } from '../viewer/thumbnails';
import { LayoutResultPreview } from './LayoutResultPreview';
import {
  setChange,
  regionStyle,
  textOf,
  TEXT_KINDS,
  type Change,
  type DocumentModel,
  type TextKind,
} from './reviewModel';
import './review.css';

export function LayoutReviewDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const open = useUi((s) => s.openDialog);
  const { pdf } = usePdfDocument(doc);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<DocumentModel | null>(null);
  const [modelPath, setModelPath] = useState('');
  const [revision, setRevision] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [image, setImage] = useState('');
  const [changes, setChanges] = useState<Change[]>([]);
  const [selectedBlock, setSelectedBlock] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const page = model?.pages[pageIndex];
  useEffect(() => {
    let active = true;
    if (pdf && page)
      void renderPageToCanvas(pdf, page.index, 410, 1)
        .then((canvas) => {
          if (active) setImage(canvas.toDataURL('image/png'));
        })
        .catch((e: unknown) => {
          if (active) showError(e);
        });
    return () => {
      active = false;
    };
  }, [pdf, page]);
  if (!doc) return null;
  const stale = !!revision && revision !== doc.state.revisionPath;
  const analyze = async () => {
    setBusy(true);
    try {
      const result = await runOp(
        'layout.analyze',
        { includeModel: true },
        { sessionId: doc.id, title: t('layoutReview.analyze') },
      );
      const data = result.data as { model?: DocumentModel; modelPath?: string } | undefined;
      if (!data?.model || !Array.isArray(data.model.pages) || !data.modelPath)
        throw new Error(t('layoutReview.badResult'));
      setModel(data.model);
      setModelPath(data.modelPath);
      setRevision(doc.state.revisionPath);
      setPageIndex(0);
      setChanges([]);
      setSelectedBlock(null);
      setWarnings(result.warnings);
      setImage('');
    } catch (e) {
      showError(e, t('layoutReview.title'));
    } finally {
      setBusy(false);
    }
  };
  const exportReviewed = async () => {
    if (!modelPath || stale) return;
    setBusy(true);
    try {
      let path = modelPath;
      if (changes.length) {
        const result = await runOp(
          'layout.review',
          { modelPath, changes },
          { sessionId: doc.id, title: t('layoutReview.save') },
        );
        const value = (result.data as { modelPath?: string } | undefined)?.modelPath;
        if (!value) throw new Error(t('layoutReview.badResult'));
        path = value;
      }
      open('documentExport', {
        modelPath: path,
        docId: doc.id,
        revisionPath: doc.state.revisionPath,
      });
    } catch (e) {
      showError(e, t('layoutReview.title'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      modalLock={busy}
      onOpenChange={(o) => !o && !busy && close()}
      size="xl"
      title={t('layoutReview.title')}
      icon={<ScanText size={18} />}
      description={t('layoutReview.description')}
      footer={
        <>
          <Button disabled={busy} onClick={() => void analyze()}>
            {t('layoutReview.analyze')}
          </Button>
          <DialogSpacer />
          <Button onClick={close} disabled={busy}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void exportReviewed()}
            disabled={busy || !model || stale}
          >
            {t('layoutReview.export')}
          </Button>
        </>
      }
    >
      {stale && <p role="alert">{t('layoutReview.stale')}</p>}
      {warnings.length > 0 && (
        <p role="status">{t('layoutReview.warnings', { warnings: warnings.join(', ') })}</p>
      )}
      {!model ? (
        <p>{t('layoutReview.hint')}</p>
      ) : (
        <>
          <div className="layout-review__nav">
            <Button
              disabled={busy || pageIndex === 0}
              onClick={() => {
                setImage('');
                setSelectedBlock(null);
                setPageIndex((n) => n - 1);
              }}
            >
              {t('layoutReview.previous')}
            </Button>
            <span>
              {t('layoutReview.page', { page: pageIndex + 1, count: model.pages.length })}
            </span>
            <Button
              disabled={busy || pageIndex >= model.pages.length - 1}
              onClick={() => {
                setImage('');
                setSelectedBlock(null);
                setPageIndex((n) => n + 1);
              }}
            >
              {t('layoutReview.next')}
            </Button>
          </div>
          <div className="layout-review__comparison">
            <div>
              <h3>{t('layoutReview.original')}</h3>
              <div className="layout-review__page">
                {image && <img src={image} alt={t('layoutReview.original')} />}
                {image &&
                  page &&
                  selectedBlock !== null &&
                  page.blocks[selectedBlock] &&
                  (() => {
                    const style = regionStyle(page, page.blocks[selectedBlock]);
                    return style ? (
                      <div
                        className="layout-review__outline"
                        style={style}
                        data-testid="layout-region"
                      />
                    ) : null;
                  })()}
              </div>
            </div>
            {page && (
              <LayoutResultPreview
                page={page}
                changes={changes}
                selectedBlock={selectedBlock}
                onSelectBlock={setSelectedBlock}
              />
            )}
          </div>
          <section className="layout-review__blocks" aria-label={t('layoutReview.blocks')}>
            <h3>{t('layoutReview.blocks')}</h3>
            <div className="layout-review__columns">
              {page?.blocks.map((block, index) => {
                const change = changes.find(
                  (c) => c.pageIndex === page.index && c.blockIndex === index,
                );
                const kind = change?.kind ?? block.kind;
                const text = change?.text ?? textOf(block);
                const editable =
                  !!block.runs && (TEXT_KINDS as readonly string[]).includes(block.kind);
                return (
                  <div className="layout-review__block" key={index}>
                    <button
                      type="button"
                      className="layout-review__locate"
                      aria-pressed={selectedBlock === index}
                      onClick={() => setSelectedBlock(index)}
                    >
                      {t('layoutReview.locate', { index: index + 1 })}
                    </button>
                    {editable ? (
                      <Select<TextKind>
                        value={kind as TextKind}
                        aria-label={t('layoutReview.kindFor', { index: index + 1 })}
                        onChange={(value) =>
                          setChanges((current) =>
                            setChange(current, {
                              pageIndex: page.index,
                              blockIndex: index,
                              kind: value,
                              ...(value === 'heading' ? { level: block.level ?? 1 } : {}),
                              ...(change?.text !== undefined ? { text: change.text } : {}),
                            }),
                          )
                        }
                        options={TEXT_KINDS.map((value) => ({
                          value,
                          label: t(`layoutReview.kinds.${value}`),
                        }))}
                      />
                    ) : (
                      <strong>
                        {t(`layoutReview.kinds.${block.kind}`, { defaultValue: block.kind })}
                      </strong>
                    )}
                    {editable && kind === 'heading' && (
                      <Select<string>
                        aria-label={t('layoutReview.headingLevel', { index: index + 1 })}
                        value={String(change?.level ?? block.level ?? 1)}
                        onChange={(value) =>
                          setChanges((current) =>
                            setChange(current, {
                              pageIndex: page.index,
                              blockIndex: index,
                              kind: 'heading',
                              level: Number(value),
                              ...(change?.text !== undefined ? { text: change.text } : {}),
                            }),
                          )
                        }
                        options={['1', '2', '3', '4', '5', '6'].map((value) => ({
                          value,
                          label: value,
                        }))}
                      />
                    )}
                    {editable ? (
                      <textarea
                        aria-label={t('layoutReview.textFor', { index: index + 1 })}
                        maxLength={100_000}
                        value={text}
                        onChange={(event) =>
                          setChanges((current) =>
                            setChange(current, {
                              pageIndex: page.index,
                              blockIndex: index,
                              kind: kind as TextKind,
                              ...(kind === 'heading'
                                ? { level: change?.level ?? block.level ?? 1 }
                                : {}),
                              text: event.target.value,
                            }),
                          )
                        }
                        rows={Math.min(5, Math.max(2, text.split('\n').length))}
                      />
                    ) : (
                      <p>{text || t('layoutReview.nonText')}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </Dialog>
  );
}
