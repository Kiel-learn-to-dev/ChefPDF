/**
 * The three ways to add an item to the library (I19-I21): from an image file (background removal
 * and clean-up), by drawing with a pointer, and by typing a name. Each flow ends with one save.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, FolderOpen, Save, Undo2 } from 'lucide-react';
import type { LibraryKind } from '@chef/contracts';
import { IMAGE_FILTERS, errorMessage } from '../../app/actions';
import { Button } from '../../components/Button';
import { Checkbox, Field, Segmented, Select, TextInput } from '../../components/Form';
import { Slider } from '../../components/Slider';
import { chef } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { join, basename } from '../../lib/path';
import { runOp } from '../../lib/rpc';
import {
  CLEANUP_STEPS,
  DEFAULT_BACKGROUND,
  DEFAULT_CLEANUP,
  DEFAULT_TYPED,
  KINDS,
  NAME_MAX,
  TYPED_FONT_EXTENSIONS,
  cleanupParams,
  fromStrokesParams,
  itemName,
  removeBackgroundParams,
  textSignatureParams,
  type BackgroundOptions,
  type CleanupOptions,
  type RawPoint,
  type TypedOptions,
} from './libraryModel';

export interface FlowProps {
  onSaved(): void;
  onCancel(): void;
}

const CANVAS = { width: 600, height: 220 } as const;

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}.png`;
}

/** Name and kind of the item plus the save / cancel buttons. */
function SaveBar({
  kind,
  name,
  busy,
  canSave,
  onKind,
  onName,
  onSave,
  onCancel,
}: {
  kind: LibraryKind;
  name: string;
  busy: boolean;
  canSave: boolean;
  onKind(k: LibraryKind): void;
  onName(n: string): void;
  onSave(): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="lib-save">
      <Field label={t('lib.kindLabel')}>
        <Select<LibraryKind>
          size="sm"
          aria-label={t('lib.kindLabel')}
          value={kind}
          onChange={onKind}
          options={KINDS.map((k) => ({ value: k, label: t(`lib.kind.${k}`) }))}
        />
      </Field>
      <Field label={t('lib.nameLabel')}>
        <TextInput
          size="sm"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => onName(e.target.value)}
        />
      </Field>
      <div className="lib-save__buttons">
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          icon={<Save size={15} />}
          loading={busy}
          disabled={!canSave}
          onClick={onSave}
        >
          {t('lib.save')}
        </Button>
      </div>
    </div>
  );
}

/** Two pictures side by side: the original and the result on a checkerboard (I20). */
function BeforeAfter({
  before,
  after,
  alt,
}: {
  before: string | null;
  after: string | null;
  alt: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="lib-compare">
      <figure>
        <figcaption>{t('lib.before')}</figcaption>
        <div className="lib-compare__pane">
          {before && <img src={chef().files.toUrl(before)} alt={t('lib.beforeAlt')} />}
        </div>
      </figure>
      <figure>
        <figcaption>{t('lib.after')}</figcaption>
        <div className="lib-compare__pane lib-compare__pane--checker">
          {after && <img src={chef().files.toUrl(after)} alt={alt} />}
        </div>
      </figure>
    </div>
  );
}

// -- (a) from an image file --------------------------------------------------------------------

export function ImageFlow({ onSaved, onCancel }: FlowProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState<string | null>(null);
  const [bg, setBg] = useState<BackgroundOptions>(DEFAULT_BACKGROUND);
  const [cl, setCl] = useState<CleanupOptions>(DEFAULT_CLEANUP);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<LibraryKind>('signature');
  const [name, setName] = useState('');
  const runSeq = useRef(0);
  const made = useRef<Set<string>>(new Set());

  const dropFiles = (keep: string | null) => {
    for (const p of made.current) {
      if (p !== keep)
        void chef()
          .library.release(p)
          .catch(() => undefined);
    }
    made.current = new Set(keep ? [keep] : []);
  };

  useEffect(() => {
    if (!input) return;
    const seq = ++runSeq.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const dir = await chef().library.workDir();
        const bgOut = join(dir, unique('bg'));
        const clOut = join(dir, unique('clean'));
        await runOp('image.removeBackground', removeBackgroundParams(bg, input, bgOut), {
          title: t('lib.jobRemove'),
          silent: true,
        });
        await runOp('image.cleanup', cleanupParams(cl, bgOut, clOut), {
          title: t('lib.jobCleanup'),
          silent: true,
        });
        await chef()
          .library.release(bgOut)
          .catch(() => undefined);
        if (seq !== runSeq.current) {
          await chef()
            .library.release(clOut)
            .catch(() => undefined);
          return;
        }
        made.current.add(clOut);
        dropFiles(clOut);
        setResult(clOut);
      } catch (e) {
        if (seq === runSeq.current) setError(errorMessage(toChefError(e)));
      } finally {
        if (seq === runSeq.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // The effect re-runs on option changes; dropFiles only touches files of earlier runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, bg, cl]);

  useEffect(() => () => dropFiles(null), []);

  const pick = async () => {
    const [picked] = await chef().files.openDialog({ multiple: false, filters: IMAGE_FILTERS });
    if (!picked) return;
    setInput(picked);
    setName(basename(picked).replace(/\.[^.]+$/, ''));
  };

  const save = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await chef().library.add({ kind, name: itemName(name, t('lib.defaultName')), path: result });
      onSaved();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lib-flow">
      <div className="lib-flow__pick">
        <Button icon={<FolderOpen size={15} />} onClick={() => void pick()}>
          {input ? t('lib.changeImage') : t('lib.pickImage')}
        </Button>
        {input && <span className="lib-flow__file">{basename(input)}</span>}
      </div>

      {input && (
        <div className="lib-flow__grid">
          <fieldset className="lib-flow__opts">
            <legend>{t('lib.bgOptions')}</legend>
            <Segmented<BackgroundOptions['mode']>
              aria-label={t('lib.bgMode')}
              value={bg.mode}
              onChange={(mode) => setBg({ ...bg, mode })}
              options={[
                { value: 'auto', label: t('lib.modes.auto') },
                { value: 'ink-color', label: t('lib.modes.inkColor') },
                { value: 'paper-white', label: t('lib.modes.paperWhite') },
              ]}
            />
            <Slider
              label={t('lib.tolerance')}
              value={bg.tolerance}
              min={0}
              max={200}
              step={1}
              onChange={(v) => setBg({ ...bg, tolerance: v })}
            />
            <Slider
              label={t('lib.sensitivity')}
              value={bg.sensitivity}
              min={0}
              max={100}
              step={1}
              onChange={(v) => setBg({ ...bg, sensitivity: v })}
            />
            <Slider
              label={t('lib.feather')}
              value={bg.feather}
              min={0}
              max={5}
              step={0.5}
              onChange={(v) => setBg({ ...bg, feather: v })}
            />

            <legend>{t('lib.cleanOptions')}</legend>
            <Slider
              label={t('lib.despeckle')}
              value={cl.minBlobPx}
              min={0}
              max={200}
              step={1}
              onChange={(v) => setCl({ ...cl, minBlobPx: v })}
            />
            <Slider
              label={t('lib.thicken')}
              value={cl.thicken}
              min={-5}
              max={5}
              step={1}
              onChange={(v) => setCl({ ...cl, thicken: v })}
            />
            <Slider
              label={t('lib.contrast')}
              value={cl.contrast}
              min={0.2}
              max={3}
              step={0.1}
              onChange={(v) => setCl({ ...cl, contrast: v })}
            />
            <Field label={t('lib.resize')}>
              <Select<string>
                size="sm"
                aria-label={t('lib.resize')}
                value={String(cl.maxSide)}
                onChange={(v) => setCl({ ...cl, maxSide: Number(v) })}
                options={CLEANUP_STEPS.map((s) => ({
                  value: String(s),
                  label: s === 0 ? t('lib.resizeKeep') : `${s} px`,
                }))}
              />
            </Field>
            <Checkbox
              checked={cl.straighten}
              onChange={(on) => setCl({ ...cl, straighten: on })}
              label={t('lib.straighten')}
            />
          </fieldset>

          <div className="lib-flow__preview">
            <BeforeAfter before={input} after={result} alt={t('lib.afterAlt')} />
            {busy && (
              <p className="lib-flow__busy" role="status">
                {t('lib.processing')}
              </p>
            )}
            {error && (
              <p className="lib__error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}

      {result && (
        <SaveBar
          kind={kind}
          name={name}
          busy={busy}
          canSave={!busy}
          onKind={setKind}
          onName={setName}
          onSave={() => void save()}
          onCancel={onCancel}
        />
      )}
      {!result && (
        <div className="lib-save__buttons">
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      )}
    </div>
  );
}

// -- (b) drawn with the pointer ----------------------------------------------------------------

export function DrawFlow({ onSaved, onCancel }: FlowProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<RawPoint[][]>([]);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<LibraryKind>('signature');
  const [name, setName] = useState('');
  const startRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, CANVAS.width, CANVAS.height);
    ctx.strokeStyle = '#1F3A93';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1]!;
        const b = stroke[i]!;
        ctx.lineWidth = 1.5 + ((a.pressure + b.pressure) / 2) * 4.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      if (stroke.length === 1) {
        ctx.beginPath();
        ctx.arc(stroke[0]!.x, stroke[0]!.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [strokes]);

  const toCanvas = (e: ReactPointerEvent<HTMLCanvasElement>): RawPoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * CANVAS.width) / rect.width,
      y: ((e.clientY - rect.top) * CANVAS.height) / rect.height,
      t: performance.now(),
      pressure: e.pressure,
      pointerType: e.pointerType,
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrawing(true);
    const p = toCanvas(e);
    startRef.current = p.t;
    setStrokes((s) => [...s, [{ ...p, t: 0 }]]);
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    const p = toCanvas(e);
    const point = { ...p, t: p.t - startRef.current };
    setStrokes((s) => {
      const last = s[s.length - 1];
      if (!last) return s;
      return [...s.slice(0, -1), [...last, point]];
    });
  };
  const onUp = () => setDrawing(false);

  const save = async () => {
    if (strokes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const dir = await chef().library.workDir();
      const out = join(dir, unique('ink'));
      await runOp('image.fromStrokes', fromStrokesParams(strokes, CANVAS, out), {
        title: t('lib.jobDraw'),
        silent: true,
      });
      await chef().library.add({ kind, name: itemName(name, t('lib.defaultName')), path: out });
      await chef()
        .library.release(out)
        .catch(() => undefined);
      onSaved();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lib-flow">
      <p className="lib-flow__hint">{t('lib.drawHint')}</p>
      <canvas
        ref={canvasRef}
        className="lib-pad"
        width={CANVAS.width}
        height={CANVAS.height}
        aria-label={t('lib.padLabel')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
      />
      <div className="lib-save__buttons">
        <Button
          icon={<Undo2 size={15} />}
          disabled={strokes.length === 0}
          onClick={() => setStrokes((s) => s.slice(0, -1))}
        >
          {t('lib.undoStroke')}
        </Button>
        <Button
          icon={<Eraser size={15} />}
          disabled={strokes.length === 0}
          onClick={() => setStrokes([])}
        >
          {t('lib.clearPad')}
        </Button>
      </div>
      {error && (
        <p className="lib__error" role="alert">
          {error}
        </p>
      )}
      <SaveBar
        kind={kind}
        name={name}
        busy={busy}
        canSave={strokes.length > 0 && !busy}
        onKind={setKind}
        onName={setName}
        onSave={() => void save()}
        onCancel={onCancel}
      />
    </div>
  );
}

// -- (c) typed name -----------------------------------------------------------------------------

export function TypeFlow({ onSaved, onCancel }: FlowProps) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<TypedOptions>(DEFAULT_TYPED);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<LibraryKind>('signature');
  const [name, setName] = useState('');
  const seq = useRef(0);

  const hasText = opts.text.trim().length > 0;

  useEffect(() => {
    if (!hasText) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      setBusy(true);
      try {
        const dir = await chef().library.workDir();
        const out = join(dir, unique('typed'));
        await runOp('image.textSignature', textSignatureParams(opts, out), {
          title: t('lib.jobType'),
          silent: true,
        });
        if (mine !== seq.current) {
          await chef()
            .library.release(out)
            .catch(() => undefined);
          return;
        }
        setResult((prev) => {
          if (prev)
            void chef()
              .library.release(prev)
              .catch(() => undefined);
          return out;
        });
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(errorMessage(toChefError(e)));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [opts, t, hasText]);

  const pickFont = async () => {
    const [picked] = await chef().files.openDialog({
      multiple: false,
      filters: [{ name: t('lib.fontFilter'), extensions: TYPED_FONT_EXTENSIONS }],
    });
    if (picked) setOpts({ ...opts, font: { kind: 'file', path: picked } });
  };

  const save = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await chef().library.add({
        kind,
        name: itemName(name || opts.text, t('lib.defaultName')),
        path: result,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lib-flow">
      <div className="lib-flow__grid">
        <fieldset className="lib-flow__opts">
          <legend>{t('lib.typeOptions')}</legend>
          <Field label={t('lib.typeText')} htmlFor="lib-type-text">
            <TextInput
              id="lib-type-text"
              size="sm"
              value={opts.text}
              maxLength={NAME_MAX}
              placeholder={t('lib.typePlaceholder')}
              onChange={(e) => setOpts({ ...opts, text: e.target.value })}
            />
          </Field>
          <Field label={t('lib.font')}>
            <Select<string>
              size="sm"
              aria-label={t('lib.font')}
              value={opts.font.kind === 'bundled' ? 'bundled' : 'file'}
              onChange={(v) =>
                v === 'bundled' ? setOpts({ ...opts, font: { kind: 'bundled' } }) : void pickFont()
              }
              options={[
                { value: 'bundled', label: t('lib.fontBundled') },
                {
                  value: 'file',
                  label: opts.font.kind === 'file' ? basename(opts.font.path) : t('lib.fontPick'),
                },
              ]}
            />
          </Field>
          <Slider
            label={t('lib.sizePx')}
            value={opts.sizePx}
            min={40}
            max={200}
            step={4}
            onChange={(v) => setOpts({ ...opts, sizePx: v })}
          />
          <Slider
            label={t('lib.slant')}
            value={opts.slantDeg}
            min={-30}
            max={30}
            step={1}
            onChange={(v) => setOpts({ ...opts, slantDeg: v })}
          />
          <Field label={t('lib.color')}>
            <input
              type="color"
              className="tpl__color"
              aria-label={t('lib.color')}
              value={opts.colorHex.toLowerCase()}
              onChange={(e) => setOpts({ ...opts, colorHex: e.target.value.toUpperCase() })}
            />
          </Field>
        </fieldset>
        <div className="lib-flow__preview">
          <figure className="lib-compare">
            <figcaption>{t('lib.after')}</figcaption>
            <div className="lib-compare__pane lib-compare__pane--checker">
              {hasText && result && <img src={chef().files.toUrl(result)} alt={t('lib.typeAlt')} />}
            </div>
          </figure>
          {busy && (
            <p className="lib-flow__busy" role="status">
              {t('lib.processing')}
            </p>
          )}
          {error && (
            <p className="lib__error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <SaveBar
        kind={kind}
        name={name}
        busy={busy}
        canSave={hasText && !!result && !busy}
        onKind={setKind}
        onName={setName}
        onSave={() => void save()}
        onCancel={onCancel}
      />
    </div>
  );
}
