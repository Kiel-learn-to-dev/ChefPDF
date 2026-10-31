/** A colour choice: the native colour picker with its hex value next to it. */
import { useId } from 'react';
import { Field } from '../../components/Form';
import { isHexColor } from './overlayModel';
import { useTranslation } from 'react-i18next';

export function ColorInput({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  onChange(hex: string): void;
}) {
  const { t } = useTranslation();
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  return (
    <Field label={label} htmlFor={inputId}>
      <div className="ov-color">
        <input
          id={inputId}
          type="color"
          className="ov-color__swatch"
          value={isHexColor(value) ? value : '#000000'}
          aria-label={t('overlay.look.colorPicker', { color: label })}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="ov-color__hex">{value}</span>
      </div>
    </Field>
  );
}
