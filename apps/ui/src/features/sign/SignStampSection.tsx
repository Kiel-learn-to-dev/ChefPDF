/**
 * "Đóng dấu kèm" section of the sign dialog (I33): an optional giáp lai and chữ ký nháy placed
 * before the signature. The forms are the stamp dialogs' own models (seamModel, initialsModel);
 * this section only edits them. Nothing here is persisted.
 */
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select, TextInput } from '../../components/Form';
import {
  DEFAULT_INITIALS_FORM,
  INITIALS_POSITIONS,
  type InitialsPosition,
} from '../stamps/initialsModel';
import { DEFAULT_SEAM_FORM, type SeamSide } from '../stamps/seamModel';
import { pickImage } from '../overlay/overlayActions';
import { NumberField } from '../overlay/OverlayControls';
import type { SignStamps } from './stampSteps';

export function SignStampSection({
  value,
  onChange,
  disabled,
}: {
  value: SignStamps;
  onChange(next: SignStamps): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const seam = value.seam;
  const initials = value.initials;

  const pickSeal = async () => {
    const path = await pickImage();
    if (path && seam) onChange({ ...value, seam: { ...seam, path } });
  };

  return (
    <section className="sign-section" aria-labelledby="sign-stamp-title">
      <h3 id="sign-stamp-title" className="sign-section__title">
        {t('signStamp.title')}
      </h3>
      <p className="sign-note">{t('signStamp.note')}</p>
      <Checkbox
        checked={seam !== null}
        disabled={disabled}
        onChange={(on) => onChange({ ...value, seam: on ? { ...DEFAULT_SEAM_FORM } : null })}
        label={t('signStamp.seamOn')}
      />
      {seam && (
        <div className="sign-grid">
          <Field label={t('signStamp.seamImage')}>
            <div className="field__row">
              <Button size="sm" disabled={disabled} onClick={() => void pickSeal()}>
                {t('signStamp.pick')}
              </Button>
              <span className="field__hint">
                {seam.path ? (seam.path.split(/[\\/]/).pop() ?? '') : t('signStamp.none')}
              </span>
            </div>
          </Field>
          <Field label={t('seam.side.label')} htmlFor="signStamp-side">
            <Select<SeamSide>
              id="signStamp-side"
              value={seam.side}
              onChange={(side) => onChange({ ...value, seam: { ...seam, side } })}
              options={[
                { value: 'right', label: t('seam.side.right') },
                { value: 'left', label: t('seam.side.left') },
              ]}
            />
          </Field>
          <NumberField
            id="signStamp-group"
            label={t('seam.groupSize')}
            value={seam.groupSize}
            min={0}
            max={10000}
            step={1}
            onChange={(groupSize) =>
              onChange({ ...value, seam: { ...seam, groupSize: Math.round(groupSize) } })
            }
          />
          <NumberField
            id="signStamp-scale"
            label={t('seam.scaleWidth')}
            value={seam.scaleWidthMm}
            min={0}
            max={1000}
            step={1}
            onChange={(scaleWidthMm) => onChange({ ...value, seam: { ...seam, scaleWidthMm } })}
          />
        </div>
      )}
      <Checkbox
        checked={initials !== null}
        disabled={disabled}
        onChange={(on) =>
          onChange({ ...value, initials: on ? { ...DEFAULT_INITIALS_FORM } : null })
        }
        label={t('signStamp.initialsOn')}
      />
      {initials && (
        <div className="sign-grid">
          <Field label={t('initials.text.label')} htmlFor="signStamp-initials-text">
            <TextInput
              id="signStamp-initials-text"
              maxLength={40}
              disabled={disabled}
              value={initials.text}
              onChange={(e) =>
                onChange({ ...value, initials: { ...initials, text: e.target.value } })
              }
            />
          </Field>
          <Field label={t('initials.position')} htmlFor="signStamp-initials-position">
            <Select<InitialsPosition>
              id="signStamp-initials-position"
              value={initials.position}
              onChange={(position) => onChange({ ...value, initials: { ...initials, position } })}
              options={INITIALS_POSITIONS.map((p) => ({ value: p, label: t(`initials.pos.${p}`) }))}
            />
          </Field>
        </div>
      )}
    </section>
  );
}
