/**
 * "Tách theo màu" (I22): splits a library item into one picture per ink colour (a red seal and a
 * blue signature under each other, for example). Every layer that matched pixels is saved as a
 * new library item named "<item> - <layer>".
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, Plus, Save, Trash2 } from 'lucide-react';
import type { LibraryItem } from '@chef/contracts';
import { errorMessage } from '../../app/actions';
import { Button, IconButton } from '../../components/Button';
import { Field, Segmented, TextInput } from '../../components/Form';
import { Slider } from '../../components/Slider';
import { ColorInput } from '../overlay/ColorInput';
import { chef } from '../../lib/bridge';
import { toChefError } from '../../lib/errors';
import { runOp } from '../../lib/rpc';
import { NAME_MAX } from './libraryModel';
import type { FlowProps } from './LibraryFlows';
import {
  MAX_LAYERS,
  MAX_LAYER_NAME,
  addLayer,
  defaultLayers,
  keptLayers,
  layerItemName,
  layerProblem,
  parseLayerRows,
  removeLayer,
  separateParams,
  type LayerForm,
  type LayerOutcome,
  type SeparateMode,
} from './separateModel';

export interface SeparateFlowProps extends FlowProps {
  item: LibraryItem;
}

/** Before / after of the separation: the item, then each layer that matched on a checkerboard. */
function SeparatePreview({
  before,
  layers,
}: {
  before: string | null;
  layers: LayerOutcome[] | null;
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
          {layers === null && <span className="lib-flow__file">{t('colorSep.notRun')}</span>}
          {layers !== null && layers.length === 0 && (
            <span className="lib-flow__file">{t('colorSep.noLayers')}</span>
          )}
          {layers?.map((l) => (
            <figure key={l.path} className="colorsep-layer">
              <img src={chef().files.toUrl(l.path)} alt={l.name} />
              <figcaption>
                {l.name}
                {l.pixels === 0 ? ` · ${t('colorSep.noMatch')}` : ''}
              </figcaption>
            </figure>
          ))}
        </div>
      </figure>
    </div>
  );
}

export function SeparateFlow({ item, onSaved, onCancel }: SeparateFlowProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SeparateMode>('auto-two');
  const [layers, setLayers] = useState<LayerForm[]>(defaultLayers);
  const [input, setInput] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<LayerOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Work-dir files this view made: the decrypted item and the layer files of the last run. */
  const made = useRef<Set<string>>(new Set());

  const release = (paths: Iterable<string>) => {
    for (const p of paths) {
      made.current.delete(p);
      void chef()
        .library.release(p)
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    let alive = true;
    const kept = made.current;
    void chef()
      .library.materialize(item.id)
      .then((p) => {
        if (!alive) {
          void chef()
            .library.release(p)
            .catch(() => undefined);
          return;
        }
        made.current.add(p);
        setInput(p);
      })
      .catch((e) => alive && setError(errorMessage(toChefError(e))));
    return () => {
      alive = false;
      release([...kept]);
    };
    // Only the item decides the decrypted copy; release is stable through the ref.
  }, [item.id]);

  const run = async () => {
    if (!input) return;
    const problem = mode === 'custom' ? layerProblem(layers) : null;
    if (problem) return setError(t(`colorSep.problem.${problem}`));
    setBusy(true);
    setError(null);
    // Release the last run first: the core writes its layer files under the same names.
    release((outcomes ?? []).map((o) => o.path));
    setOutcomes(null);
    try {
      const dir = await chef().library.workDir();
      const result = await runOp('image.separateColors', separateParams(input, dir, mode, layers), {
        title: t('colorSep.job'),
        silent: true,
      });
      const rows = parseLayerRows(result.data);
      for (const r of rows) made.current.add(r.path);
      setOutcomes(rows);
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const kept = keptLayers(outcomes ?? []);
    if (kept.length === 0) return;
    setBusy(true);
    try {
      for (const o of kept) {
        await chef().library.add({
          kind: item.kind,
          name: layerItemName(item.name, o.name, t('colorSep.fallbackName')),
          path: o.path,
        });
      }
      onSaved();
    } catch (e) {
      setError(errorMessage(toChefError(e)));
    } finally {
      setBusy(false);
    }
  };

  const kept = keptLayers(outcomes ?? []);

  return (
    <div className="lib-flow colorsep">
      <Segmented<SeparateMode>
        aria-label={t('colorSep.mode.label')}
        value={mode}
        onChange={(m) => setMode(m)}
        options={[
          { value: 'auto-two', label: t('colorSep.mode.auto') },
          { value: 'custom', label: t('colorSep.mode.custom') },
        ]}
      />

      {mode === 'custom' && (
        <ul className="colorsep__layers" aria-label={t('colorSep.layers')}>
          {layers.map((l, i) => (
            <li key={i} className="colorsep__layer">
              <Field label={t('colorSep.layerName')}>
                <TextInput
                  value={l.name}
                  maxLength={MAX_LAYER_NAME}
                  onChange={(e) =>
                    setLayers(layers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                  }
                />
              </Field>
              <ColorInput
                label={t('colorSep.layerColor')}
                value={l.colorHex}
                onChange={(hex) =>
                  setLayers(layers.map((x, j) => (j === i ? { ...x, colorHex: hex } : x)))
                }
              />
              <Slider
                label={t('colorSep.tolerance')}
                value={l.tolerance}
                min={0}
                max={255}
                step={1}
                onChange={(v) =>
                  setLayers(layers.map((x, j) => (j === i ? { ...x, tolerance: v } : x)))
                }
              />
              <IconButton
                label={t('colorSep.removeLayer')}
                icon={<Trash2 size={14} />}
                disabled={layers.length <= 1}
                onClick={() => setLayers(removeLayer(layers, i))}
              />
            </li>
          ))}
          <li>
            <Button
              icon={<Plus size={14} />}
              disabled={layers.length >= MAX_LAYERS}
              onClick={() =>
                setLayers(addLayer(layers, t('colorSep.newLayer', { n: layers.length + 1 })))
              }
            >
              {t('colorSep.addLayer')}
            </Button>
          </li>
        </ul>
      )}

      <div className="lib-flow__pick">
        <Button
          variant="secondary"
          icon={<Eraser size={15} />}
          loading={busy}
          disabled={!input || busy}
          onClick={() => void run()}
        >
          {t('colorSep.run')}
        </Button>
      </div>

      {error && (
        <p className="lib__error" role="alert">
          {error}
        </p>
      )}

      <SeparatePreview before={input} layers={outcomes} />

      <div className="lib-save">
        <span className="lib-flow__file">{t('colorSep.saveHint', { max: NAME_MAX })}</span>
        <div className="lib-save__buttons">
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Save size={15} />}
            loading={busy}
            disabled={busy || kept.length === 0}
            onClick={() => void save()}
          >
            {t('colorSep.save', { n: kept.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
