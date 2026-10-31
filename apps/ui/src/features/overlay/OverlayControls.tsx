/**
 * Form controls shared by the overlay dialogs: anchor grid, page selection, position with unit and
 * "place on the page", page-position diagram, variable chips, and an approximate page preview.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { Button } from '../../components/Button';
import { Field, Segmented, Select, TextInput } from '../../components/Form';
import {
  ANCHOR_GRID,
  CHIP_VARIABLES,
  NUMBER_POSITIONS,
  type Anchor,
  type NumberPosition,
  type PagesSel,
  type Unit,
} from './overlayModel';
import type { PagesChoice } from './overlayModel';
import { VARIABLE_NAMES } from './variables';
import { useViewStore } from '../../app/state/viewer';
import type { DocTab } from '../../app/state/documents';
import type { PreviewDoc } from './variables';

/** A number input that shows an empty field for NaN. */
export const numberValue = (n: number) => (Number.isFinite(n) ? n : '');

/** 3x3 anchor selector (where the anchor point sits on the object). */
export function AnchorPicker({ value, onChange }: { value: Anchor; onChange(a: Anchor): void }) {
  const { t } = useTranslation();
  return (
    <div className="ov-anchor" role="radiogroup" aria-label={t('overlay.anchor.label')}>
      {ANCHOR_GRID.flat().map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          aria-label={t(`overlay.anchor.${a}`)}
          title={t(`overlay.anchor.${a}`)}
          className="ov-anchor__cell"
          data-selected={value === a || undefined}
          onClick={() => onChange(a)}
        />
      ))}
    </div>
  );
}

/** Pages: the page shown, all, a range text, odd or even pages. */
export function PagesField({
  value,
  onChange,
  pageCount,
  currentPage,
  invalid,
  id,
}: {
  value: PagesSel;
  onChange(v: PagesSel): void;
  pageCount: number;
  /** 1-based page shown. */
  currentPage: number;
  invalid?: boolean;
  id: string;
}) {
  const { t } = useTranslation();
  const options: { value: PagesChoice; label: string }[] = [
    { value: 'current', label: t('overlay.pages.current', { page: currentPage }) },
    { value: 'all', label: t('overlay.pages.all', { count: pageCount }) },
    { value: 'range', label: t('overlay.pages.range') },
    { value: 'odd', label: t('overlay.pages.odd') },
    { value: 'even', label: t('overlay.pages.even') },
  ];
  return (
    <Field
      label={t('overlay.pages.label')}
      htmlFor={`${id}-choice`}
      hint={value.choice === 'range' ? t('range.hint') : undefined}
    >
      <div className="field__row">
        <Select<PagesChoice>
          id={`${id}-choice`}
          value={value.choice}
          onChange={(choice) => onChange({ ...value, choice })}
          options={options}
          aria-label={t('overlay.pages.label')}
        />
        {value.choice === 'range' && (
          <TextInput
            id={`${id}-range`}
            aria-label={t('overlay.pages.rangeText')}
            placeholder={t('range.hint')}
            value={value.range}
            invalid={invalid}
            onChange={(e) => onChange({ ...value, range: e.target.value })}
          />
        )}
      </div>
    </Field>
  );
}

/** Unit switch (pt / mm) shared by the position fields. */
export function UnitSwitch({ value, onChange }: { value: Unit; onChange(u: Unit): void }) {
  const { t } = useTranslation();
  return (
    <Segmented<Unit>
      aria-label={t('overlay.unit.label')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'mm', label: t('overlay.unit.mm') },
        { value: 'pt', label: t('overlay.unit.pt') },
      ]}
    />
  );
}

/** A labelled number input. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  invalid,
}: {
  id: string;
  label: ReactNode;
  value: number;
  onChange(n: number): void;
  min?: number;
  max?: number;
  step?: number;
  hint?: ReactNode;
  invalid?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <TextInput
        id={id}
        type="number"
        min={min}
        max={max}
        step={step ?? 'any'}
        value={numberValue(value)}
        invalid={invalid}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

/** Position of the anchor point with a unit and the button that places it on the page. */
export function PositionFields({
  idPrefix,
  x,
  y,
  unit,
  onChange,
  onPlace,
  placeDisabled,
  invalid,
  fixedUnit,
}: {
  idPrefix: string;
  x: number;
  y: number;
  unit: Unit;
  /** Hides the unit switch: the core takes this object's position in `unit` only. */
  fixedUnit?: boolean;
  onChange(p: { x?: number; y?: number; unit?: Unit }): void;
  /** Starts the drag placement; hidden when not given. */
  onPlace?(): void;
  placeDisabled?: boolean;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="ov-position">
      <div className="ov-position__head">
        <span className="field__label">{t('overlay.position.label')}</span>
        {!fixedUnit && <UnitSwitch value={unit} onChange={(u) => onChange({ unit: u })} />}
      </div>
      <div className="ov-position__fields">
        <NumberField
          id={`${idPrefix}-x`}
          label={t('overlay.position.x', { unit: t(`overlay.unit.${unit}`) })}
          value={x}
          step={unit === 'mm' ? 0.5 : 1}
          invalid={invalid}
          onChange={(v) => onChange({ x: v })}
        />
        <NumberField
          id={`${idPrefix}-y`}
          label={t('overlay.position.y', { unit: t(`overlay.unit.${unit}`) })}
          value={y}
          step={unit === 'mm' ? 0.5 : 1}
          invalid={invalid}
          onChange={(v) => onChange({ y: v })}
        />
        {onPlace && (
          <Button
            icon={<MapPin size={14} />}
            disabled={placeDisabled}
            onClick={onPlace}
            title={t('overlay.position.placeHint')}
          >
            {t('overlay.position.place')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Page diagram with the six number positions; the chosen one is highlighted. */
export function PositionDiagram({
  value,
  onChange,
}: {
  value: NumberPosition;
  onChange(p: NumberPosition): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="ov-diagram" role="radiogroup" aria-label={t('overlay.position.label')}>
      {NUMBER_POSITIONS.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          aria-label={t(`overlay.numberPos.${p}`)}
          title={t(`overlay.numberPos.${p}`)}
          className="ov-diagram__cell"
          data-pos={p}
          data-selected={value === p || undefined}
          onClick={() => onChange(p)}
        />
      ))}
    </div>
  );
}

/** Chips that add a variable to the field that has the focus (`onPick` gets the name). */
export function VariableChips({
  onPick,
  focusLabel,
}: {
  onPick(name: string): void;
  focusLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="ov-chips" aria-label={t('overlay.vars.label')}>
      <span className="ov-chips__hint">{focusLabel ?? t('overlay.vars.hint')}</span>
      {CHIP_VARIABLES.filter((v) => (VARIABLE_NAMES as readonly string[]).includes(v)).map((v) => (
        <button
          key={v}
          type="button"
          className="ov-chip"
          onClick={() => onPick(v)}
          title={t(`overlay.vars.${v}`)}
        >
          {`{${v}}`}
        </button>
      ))}
    </div>
  );
}

/** A page drawn at its real proportions; the children sit on it in percent (approximate preview). */
export function PagePreview({
  width,
  height,
  label,
  children,
  imageUrl,
}: {
  width: number;
  height: number;
  label?: string;
  children?: ReactNode;
  imageUrl?: string;
}) {
  return (
    <div
      className="ov-page"
      style={{ aspectRatio: `${width} / ${height}` }}
      data-testid="overlay-preview"
    >
      {imageUrl && <img className="ov-page__img" src={imageUrl} alt="" />}
      {children}
      {label && <span className="ov-page__label">{label}</span>}
    </div>
  );
}

/** The page shown in the viewer (0-based), from the view state of the document. */
export function useCurrentPage(docId: string | undefined): number {
  const page = useViewStore((s) => (docId ? s.views[docId]?.page : undefined));
  return Math.max(0, (page ?? 1) - 1);
}

/** Document values for the variable preview, from the open document (metadata when present). */
export function previewDocOf(
  doc: DocTab,
  bates: { prefix: string; suffix: string; digits: number },
  startNumber: number,
  dateFormat: string,
): PreviewDoc {
  const meta = doc.info.metadata;
  return {
    filename: doc.name.replace(/\.pdf$/i, ''),
    title: meta.Title ?? '',
    author: meta.Author ?? '',
    pageCount: doc.info.pageCount,
    startNumber,
    dateFormat,
    now: new Date(),
    sections: [],
    batesPrefix: bates.prefix,
    batesSuffix: bates.suffix,
    batesDigits: bates.digits,
  };
}
