/**
 * Properties of the selected objects (D4, D6, D7) in the right panel: kind, size in mm, font or
 * pixel size, layer, and the actions. Destructive actions are disabled on signed documents (the
 * core refuses them too); the reason is a tooltip.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  Crop,
  Download,
  ImagePlus,
  Trash2,
} from 'lucide-react';
import type { DocTab } from '../../app/state/documents';
import { Button } from '../../components/Button';
import { Collapsible, Select, Checkbox } from '../../components/Form';
import { Badge } from '../../components/Misc';
import { useObjectEdit, selectedObjects } from './objectState';
import {
  adjustSelectedImage,
  colourSelection,
  deleteSelection,
  duplicateSelection,
  extractSelectedImage,
  opacitySelection,
  replaceSelectedImage,
  reorderSelection,
  selectedImage,
} from './objectActions';
import {
  DEFAULT_ADJUST,
  bboxSize,
  isIdentityAdjust,
  ptToMmText,
  type ImageAdjust,
  type ImageFit,
  type PageObject,
} from './objectModel';

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="panel__row">
      <span className="panel__key">{k}</span>
      <span className="panel__val">{v}</span>
    </div>
  );
}

const FIT_OPTIONS: { value: ImageFit; label: string }[] = [
  { value: 'contain', label: 'Vừa khung' },
  { value: 'cover', label: 'Lấp khung' },
  { value: 'stretch', label: 'Kéo đầy khung' },
];

function Details({ obj }: { obj: PageObject }) {
  const { t } = useTranslation();
  const { w, h } = bboxSize(obj.bbox);
  return (
    <>
      <Row k={t('objects.prop.kind')} v={t(`objects.kind.${obj.kind}`)} />
      <Row
        k={t('objects.prop.size')}
        v={`${ptToMmText(w)} × ${ptToMmText(h)} ${t('objects.prop.mm')}`}
      />
      <Row
        k={t('objects.prop.position')}
        v={`${ptToMmText(obj.bbox[0])}, ${ptToMmText(obj.bbox[1])} ${t('objects.prop.mm')}`}
      />
      {obj.kind === 'text' && (
        <Row k={t('objects.prop.font')} v={`${obj.font ?? '—'} · ${obj.fontSize ?? '—'} pt`} />
      )}
      {obj.kind === 'image' && (
        <Row
          k={t('objects.prop.pixels')}
          v={obj.pixelSize ? `${obj.pixelSize[0]} × ${obj.pixelSize[1]} px` : '—'}
        />
      )}
      <Row k={t('objects.prop.layer')} v={obj.layer ?? t('objects.prop.noLayer')} />
      <Row
        k={t('objects.prop.opacity')}
        v={`${Math.round(obj.opacity[0] * 100)}%${obj.clipped ? ` · ${t('objects.prop.clipped')}` : ''}`}
      />
    </>
  );
}

function ImageTools({ doc, blocked }: { doc: DocTab; blocked: boolean }) {
  const { t } = useTranslation();
  const [fit, setFit] = useState<ImageFit>('contain');
  const [adjust, setAdjust] = useState<ImageAdjust>(DEFAULT_ADJUST);
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const cropOf = (): ImageAdjust['crop'] =>
    crop.w > 0 && crop.h > 0 ? { x: crop.x, y: crop.y, w: crop.w, h: crop.h } : undefined;
  const withCrop: ImageAdjust = { ...adjust, crop: cropOf() };
  const set = (patch: Partial<ImageAdjust>) => setAdjust((a) => ({ ...a, ...patch }));
  const num = (
    value: number,
    onChange: (n: number) => void,
    label: string,
    min: number,
    max: number,
    step: number,
  ) => (
    <label className="obj-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
  return (
    <>
      <div className="panel__actions">
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<ImagePlus size={14} />}
          disabled={blocked}
          title={blocked ? t('overlay.signedBlocked') : undefined}
          onClick={() => void replaceSelectedImage(doc.id, fit)}
        >
          {t('objects.image.replace')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<Download size={14} />}
          onClick={() => void extractSelectedImage(doc.id)}
        >
          {t('objects.image.extract')}
        </Button>
      </div>
      <div className="obj-field-row">
        <Select<ImageFit>
          aria-label={t('objects.image.fit')}
          value={fit}
          onChange={setFit}
          options={FIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </div>
      <Collapsible label={t('objects.image.adjust')}>
        <div className="obj-fields">
          {num(
            adjust.brightness,
            (n) => set({ brightness: n }),
            t('objects.image.brightness'),
            -100,
            100,
            1,
          )}
          {num(
            adjust.contrast,
            (n) => set({ contrast: n }),
            t('objects.image.contrast'),
            -100,
            100,
            1,
          )}
          {num(
            adjust.saturation,
            (n) => set({ saturation: n }),
            t('objects.image.saturation'),
            -100,
            100,
            1,
          )}
          {num(adjust.gamma, (n) => set({ gamma: n || 1 }), t('objects.image.gamma'), 0.1, 5, 0.05)}
        </div>
        <div className="obj-fields" role="group" aria-label={t('objects.image.crop')}>
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label className="obj-field" key={k}>
              <span>{t(`objects.image.crop${k.toUpperCase()}`)}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={crop[k]}
                onChange={(e) =>
                  setCrop((c) => ({
                    ...c,
                    [k]: Math.max(0, Math.round(Number(e.target.value) || 0)),
                  }))
                }
              />
            </label>
          ))}
        </div>
        <div className="obj-field-row">
          <Select<string>
            aria-label={t('objects.image.rotate')}
            value={String(adjust.rotate)}
            onChange={(v) => set({ rotate: Number(v) as ImageAdjust['rotate'] })}
            options={[
              { value: '0', label: t('objects.image.rotate0') },
              { value: '90', label: t('objects.image.rotate90') },
              { value: '180', label: t('objects.image.rotate180') },
              { value: '270', label: t('objects.image.rotate270') },
            ]}
          />
          <Select<ImageAdjust['flip']>
            aria-label={t('objects.image.flip')}
            value={adjust.flip}
            onChange={(v) => set({ flip: v })}
            options={[
              { value: 'none', label: t('objects.image.flipNone') },
              { value: 'h', label: t('objects.image.flipH') },
              { value: 'v', label: t('objects.image.flipV') },
            ]}
          />
        </div>
        <Checkbox
          checked={adjust.grayscale}
          onChange={(v) => set({ grayscale: v })}
          label={t('objects.image.grayscale')}
        />
        <Checkbox
          checked={adjust.invert}
          onChange={(v) => set({ invert: v })}
          label={t('objects.image.invert')}
        />
        <Button
          size="sm"
          variant="primary"
          icon={<Crop size={14} />}
          disabled={blocked || isIdentityAdjust(withCrop)}
          title={blocked ? t('overlay.signedBlocked') : undefined}
          onClick={() => {
            void adjustSelectedImage(doc.id, withCrop).then((ok) => {
              if (ok) {
                setAdjust(DEFAULT_ADJUST);
                setCrop({ x: 0, y: 0, w: 0, h: 0 });
              }
            });
          }}
        >
          {t('objects.image.apply')}
        </Button>
      </Collapsible>
    </>
  );
}

/** Object section of the right panel: shown in the object edit mode when something is selected. */
export function ObjectPanel({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const active = useObjectEdit((s) => s.active);
  const selected = useObjectEdit((s) => s.selected);
  const objects = useObjectEdit((s) => s.objects);
  if (!active) return null;
  const objs = selectedObjects(objects, selected);
  if (selected.length === 0) {
    return (
      <section className="panel__section" data-testid="object-panel">
        <h3 className="panel__heading">{t('objects.panel.title')}</h3>
        <p className="panel__text">{t('objects.panel.none')}</p>
      </section>
    );
  }
  const blocked = doc.state.signed;
  const busy = doc.busy > 0;
  const off = busy || blocked;
  const single = objs.length === 1 ? objs[0]! : null;
  const canFill = objs.length > 0 && objs.every((o) => o.kind === 'text' || o.kind === 'path');
  const canStroke = objs.length > 0 && objs.every((o) => o.kind === 'path');
  const hasImage = selectedImage() !== null;
  const counts = objs.reduce<Record<string, number>>(
    (acc, o) => ({ ...acc, [o.kind]: (acc[o.kind] ?? 0) + 1 }),
    {},
  );

  return (
    <section className="panel__section" data-testid="object-panel">
      <h3 className="panel__heading">
        {t('objects.panel.title')}
        <Badge tone="accent">{selected.length}</Badge>
      </h3>
      {single ? (
        <Details obj={single} />
      ) : (
        <p className="panel__text">
          {Object.entries(counts)
            .map(([k, n]) => `${n} ${t(`objects.kind.${k}`)}`)
            .join(' · ')}
        </p>
      )}
      <div className="panel__actions">
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<Trash2 size={14} />}
          disabled={off}
          title={blocked ? t('overlay.signedBlocked') : undefined}
          onClick={() => void deleteSelection(doc.id)}
        >
          {t('objects.act.delete')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<Copy size={14} />}
          disabled={off}
          title={blocked ? t('overlay.signedBlocked') : undefined}
          onClick={() => void duplicateSelection(doc.id)}
        >
          {t('objects.act.duplicate')}
        </Button>
      </div>
      <div className="panel__actions" role="group" aria-label={t('objects.act.order')}>
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<ArrowUpToLine size={14} />}
          disabled={off}
          onClick={() => void reorderSelection(doc.id, 'front')}
        >
          {t('objects.act.front')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<ArrowDownToLine size={14} />}
          disabled={off}
          onClick={() => void reorderSelection(doc.id, 'back')}
        >
          {t('objects.act.back')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<ArrowUp size={14} />}
          disabled={off}
          onClick={() => void reorderSelection(doc.id, 'forward')}
        >
          {t('objects.act.forward')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="panel__action"
          icon={<ArrowDown size={14} />}
          disabled={off}
          onClick={() => void reorderSelection(doc.id, 'backward')}
        >
          {t('objects.act.backward')}
        </Button>
      </div>
      {(canFill || canStroke) && (
        <div className="obj-fields">
          {canFill && (
            <label className="obj-field">
              <span>{t('objects.prop.fill')}</span>
              <input
                type="color"
                value={firstColour(objs, 'fillColor')}
                disabled={off}
                onChange={(e) => void colourSelection(doc.id, { fill: e.target.value })}
              />
            </label>
          )}
          {canStroke && (
            <label className="obj-field">
              <span>{t('objects.prop.stroke')}</span>
              <input
                type="color"
                value={firstColour(objs, 'strokeColor')}
                disabled={off}
                onChange={(e) => void colourSelection(doc.id, { stroke: e.target.value })}
              />
            </label>
          )}
        </div>
      )}
      <label className="obj-field obj-field--wide">
        <span>{t('objects.prop.opacityValue')}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          defaultValue={Math.round((objs[0]?.opacity[0] ?? 1) * 100)}
          key={selected.join('|')}
          disabled={off}
          onMouseUp={(e) => void opacitySelection(doc.id, Number(e.currentTarget.value) / 100)}
          onKeyUp={(e) => void opacitySelection(doc.id, Number(e.currentTarget.value) / 100)}
          aria-label={t('objects.prop.opacityValue')}
        />
      </label>
      {hasImage && <ImageTools doc={doc} blocked={off} />}
    </section>
  );
}

function firstColour(objs: PageObject[], key: 'fillColor' | 'strokeColor'): string {
  const v = objs.find((o) => o[key])?.[key];
  return v ?? '#000000';
}
