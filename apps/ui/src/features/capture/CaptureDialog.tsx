/**
 * "Chụp bằng điện thoại" (L5 / T8.11, and I19 signature photos): shows a QR code, receives
 * photos from the phone (main process LAN server), then makes a PDF or hands the first photo to
 * the signature library.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Smartphone, X } from 'lucide-react';
import { useUi } from '../../app/state/ui';
import { useDocs } from '../../app/state/documents';
import {
  announceOutputs,
  openFiles,
  pickSavePath,
  runDocOp,
  saveDoc,
  showError,
} from '../../app/actions';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Checkbox } from '../../components/Form';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import type { OpId } from '../../lib/ops';
import {
  DEFAULT_CAPTURE_OPTIONS,
  INITIAL_CAPTURE,
  captureErrorKey,
  captureReducer,
  capturePdfParams,
  capturePlan,
  reviewPagesOf,
  type CaptureOptions,
} from './captureModel';
import './capture.css';

/** Photos asked for in one session (the main process limit is 500). */
const MAX_PAGES = 200;

export interface CaptureDialogData {
  /**
   * `signature`: the chosen photo goes to the signature library (it reopens with `seedImage`).
   * Default `book`.
   */
  purpose?: 'book' | 'signature';
}

export function CaptureDialog() {
  const { t } = useTranslation();
  const close = useUi((s) => s.closeDialog);
  const data = (useUi((s) => s.dialogData) ?? {}) as CaptureDialogData;
  const purpose = data.purpose ?? 'book';
  const [model, dispatch] = useReducer(captureReducer, INITIAL_CAPTURE);
  const [options, setOptions] = useState<CaptureOptions>(DEFAULT_CAPTURE_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const live = useRef(false); // a session of this dialog is running on the main process
  const mounted = useRef(false);
  const sessionId = useRef<string | null>(null);

  // Events of the running session.
  useEffect(() => {
    return chef().onEvent((event) => dispatch({ type: 'event', event }));
  }, []);

  // Closing the dialog ends the session (the server must not outlive the dialog).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (live.current && sessionId.current)
        void chef()
          .capture.stop(sessionId.current)
          .catch(() => undefined);
    };
  }, []);

  const start = async () => {
    dispatch({ type: 'starting' });
    try {
      const r = await chef().capture.start({ purpose, maxPages: MAX_PAGES });
      if (!mounted.current) {
        await chef()
          .capture.stop(r.sessionId)
          .catch(() => undefined);
        return;
      }
      sessionId.current = r.sessionId;
      live.current = true;
      dispatch({ type: 'started', result: r });
    } catch (e) {
      if (!mounted.current) return;
      const code = (e as { code?: string }).code ?? 'INTERNAL';
      dispatch({ type: 'failed', code });
    }
  };

  const finish = async () => {
    live.current = false;
    const id = sessionId.current;
    sessionId.current = null;
    await chef()
      .capture.stop(id ?? undefined)
      .catch(() => undefined);
    dispatch({
      type: 'event',
      event: { type: 'capture-status', state: 'stopped', count: model.photos.length, expiresAt: 0 },
    });
  };

  const paths = model.photos.map((p) => p.path);

  const makePdf = async () => {
    if (paths.length === 0) return;
    const name = `Chụp ${new Date().toISOString().slice(0, 10)}.pdf`;
    const out = await pickSavePath(name);
    if (!out) return;
    const outPath = out.toLowerCase().endsWith('.pdf') ? out : `${out}.pdf`;
    setBusy(true);
    try {
      const title = t('capture.pdfJob');
      const r = await runOp('convert.imagesToPdf', capturePdfParams(paths, outPath) as never, {
        title,
      });
      const plan = capturePlan(options);
      if (plan.length > 0) {
        // Opening the new PDF gives a document session; the plan runs on it in order.
        await openFiles([outPath]);
        const doc = useDocs.getState().docs.find((d) => d.state.sourcePath === outPath);
        if (!doc || !(await runPlan(doc.id, plan)) || !(await saveDoc(doc.id))) return;
      }
      announceOutputs(title, r.outputs);
      close();
    } catch (e) {
      showError(e, t('errors.opFailed', { title: t('capture.pdfJob') }));
    } finally {
      setBusy(false);
    }
  };

  const runPlan = async (docId: string, plan: ReturnType<typeof capturePlan>): Promise<boolean> => {
    const review = new Set<number>();
    for (const step of plan) {
      const r = await runDocOp(
        docId,
        step.opId as OpId,
        step.params as never,
        t(`capture.step.${step.title}`),
      );
      if (!r) return false;
      if (step.opId === 'pageimg.autoCrop') for (const i of reviewPagesOf(r.data)) review.add(i);
    }
    if (review.size > 0) {
      const pages = [...review].sort((a, b) => a - b).map((i) => i + 1);
      toast.warning(t('capture.title'), t('capture.reviewPages', { pages: pages.join(', ') }));
    }
    return true;
  };

  // The library is the only other dialog and DialogHost shows one at a time, so the library
  // reopens with the photo as its seed (it then runs the background removal flow on it).
  const useSignature = () => {
    const photo = model.photos[picked ?? 0];
    if (!photo) return;
    useUi.getState().openDialog('sigLibrary', { seedImage: photo.path });
  };

  const bodyState = model.phase;
  const footer = (() => {
    if (bodyState === 'idle' || bodyState === 'error') {
      return (
        <>
          <Button variant="ghost" onClick={() => close()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void start()}>
            {bodyState === 'error' ? t('capture.retry') : t('capture.start')}
          </Button>
        </>
      );
    }
    if (bodyState === 'waiting' || bodyState === 'starting') {
      return (
        <>
          <Button variant="ghost" onClick={() => close()}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void finish()}
            disabled={bodyState === 'starting'}
          >
            {t('capture.done')}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button variant="ghost" onClick={() => close()} disabled={busy}>
          {t('common.cancel')}
        </Button>
        {purpose === 'signature' ? (
          <Button variant="primary" onClick={useSignature} disabled={paths.length === 0}>
            {t('capture.useSignature')}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => void makePdf()}
            disabled={paths.length === 0 || busy}
            loading={busy}
          >
            {t('capture.makePdf')}
          </Button>
        )}
      </>
    );
  })();

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={t('capture.title')}
      icon={<Smartphone size={18} />}
      description={t('capture.description')}
      size="lg"
      modalLock={busy}
      footer={footer}
    >
      <div className="capture">
        {(bodyState === 'idle' || bodyState === 'starting') && (
          <div className="capture__intro">
            <p>{t('capture.intro')}</p>
            <button
              type="button"
              className="capture__start"
              onClick={() => void start()}
              disabled={bodyState === 'starting'}
            >
              <Smartphone size={28} aria-hidden />
              <span>{bodyState === 'starting' ? t('capture.starting') : t('capture.start')}</span>
            </button>
          </div>
        )}

        {bodyState === 'error' && (
          <p className="capture__error" role="alert">
            {t(captureErrorKey(model.errorCode))}
          </p>
        )}

        {bodyState === 'waiting' && (
          <div className="capture__wait">
            <div className="capture__qr" dangerouslySetInnerHTML={{ __html: model.qrSvg }} />
            <div className="capture__info">
              <p className="capture__hint">{t('capture.sameWifi')}</p>
              <p className="capture__url">
                <code>{model.url}</code>
              </p>
              {model.interfaces.length > 1 && (
                <p className="capture__muted">
                  {t('capture.interfaces', {
                    list: model.interfaces.map((i) => i.address).join(', '),
                  })}
                </p>
              )}
              <p className="capture__firewall">{t('capture.firewall')}</p>
              <p className="capture__count" aria-live="polite">
                {t('capture.received', { count: model.photos.length })}
              </p>
            </div>
          </div>
        )}

        {bodyState === 'review' && (
          <>
            {model.notice === 'EXPIRED' && (
              <p className="capture__muted">{t('capture.errExpired')}</p>
            )}
            <p className="capture__count">
              {t('capture.received', { count: model.photos.length })}
            </p>
          </>
        )}

        {(bodyState === 'waiting' || bodyState === 'review') && model.photos.length > 0 && (
          <ul className="capture__strip" aria-label={t('capture.stripLabel')}>
            {model.photos.map((p, i) => (
              <li
                key={p.index}
                className={`capture__thumb${picked === p.index || (picked === null && i === 0 && purpose === 'signature') ? ' is-picked' : ''}`}
              >
                <button
                  type="button"
                  className="capture__pick"
                  onClick={() => setPicked(p.index)}
                  aria-label={t('capture.photo', { n: i + 1 })}
                  disabled={bodyState === 'waiting'}
                >
                  <img src={chef().files.toUrl(p.path)} alt="" />
                </button>
                <span className="capture__num">{i + 1}</span>
                {bodyState === 'review' && (
                  <span className="capture__tools">
                    <button
                      type="button"
                      aria-label={t('capture.moveLeft')}
                      disabled={i === 0}
                      onClick={() => dispatch({ type: 'move', from: i, to: i - 1 })}
                    >
                      <ArrowLeft size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('capture.moveRight')}
                      disabled={i === model.photos.length - 1}
                      onClick={() => dispatch({ type: 'move', from: i, to: i + 1 })}
                    >
                      <ArrowRight size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('capture.remove')}
                      onClick={() => dispatch({ type: 'remove', index: p.index })}
                    >
                      <X size={14} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {bodyState === 'review' && purpose === 'book' && (
          <fieldset className="capture__options">
            <legend>{t('capture.options')}</legend>
            <Checkbox
              checked={options.autoCrop}
              onChange={(autoCrop) => setOptions({ ...options, autoCrop })}
              label={t('capture.optCrop')}
              hint={t('capture.optCropHint')}
            />
            <Checkbox
              checked={options.splitSpread}
              onChange={(splitSpread) => setOptions({ ...options, splitSpread })}
              label={t('capture.optSplit')}
              hint={t('capture.optSplitHint')}
            />
            <Checkbox
              checked={options.whiten}
              onChange={(whiten) => setOptions({ ...options, whiten })}
              label={t('capture.optWhiten')}
            />
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
