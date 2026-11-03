import { useTranslation } from 'react-i18next';
import { useUi } from '../../app/state/ui';
import { Checkbox, Field, RadioGroup, TextInput } from '../../components/Form';
import type { FormField, FormValue } from './formsModel';

export function FieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  value: FormValue;
  disabled: boolean;
  onChange(value: boolean | string | string[]): void;
}) {
  const { t } = useTranslation();
  const title = field.tooltip || t(`forms.kind.${field.type}`, { defaultValue: field.type });
  const readOnly = disabled || field.flags.readOnly;

  if (field.type === 'checkbox') {
    return (
      <div className="forms-field">
        <Checkbox
          checked={value === true}
          onChange={(checked) => onChange(checked)}
          label={field.name}
          hint={field.flags.required ? t('forms.required') : undefined}
          disabled={readOnly}
        />
      </div>
    );
  }
  if (field.type === 'radio') {
    return (
      <Field label={field.name} hint={field.flags.required ? t('forms.required') : undefined}>
        <RadioGroup<string>
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          aria-label={field.name}
          options={field.options.map((option) => ({
            value: option.export,
            label: option.display,
            disabled: readOnly,
          }))}
        />
      </Field>
    );
  }
  if (field.type === 'dropdown') {
    return (
      <Field label={field.name} hint={field.flags.required ? t('forms.required') : undefined}>
        <select
          className="forms-field__select"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          disabled={readOnly}
          aria-label={field.name}
        >
          <option value="">{t('forms.choose')}</option>
          {field.options.map((option) => (
            <option key={option.export} value={option.export}>
              {option.display}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (field.type === 'listbox') {
    const selected = Array.isArray(value)
      ? value
      : typeof value === 'string' && value
        ? [value]
        : [];
    return (
      <Field label={field.name} hint={field.flags.required ? t('forms.required') : undefined}>
        <div className="forms-field__options" role="group" aria-label={field.name}>
          {field.options.map((option) => (
            <Checkbox
              key={option.export}
              checked={selected.includes(option.export)}
              disabled={readOnly}
              label={option.display}
              onChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, option.export]
                    : selected.filter((item) => item !== option.export),
                )
              }
            />
          ))}
        </div>
      </Field>
    );
  }
  if (field.type === 'signature') {
    return (
      <Field label={field.name} hint={t('forms.signatureHint')}>
        <button
          type="button"
          className="forms-field__signature"
          disabled={disabled}
          onClick={() => useUi.getState().openDialog('signDoc')}
        >
          {t('forms.signField')}
        </button>
      </Field>
    );
  }
  if (field.type === 'button') {
    return (
      <p className="forms-field__static">
        {field.name} · {t('forms.buttonField')}
      </p>
    );
  }

  const text = typeof value === 'string' ? value : '';
  const hint = [
    field.flags.required ? t('forms.required') : '',
    field.flags.maxLen ? t('forms.maxLen', { count: field.flags.maxLen }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Field label={field.name} hint={hint || undefined}>
      {field.type === 'multiline' || field.flags.multiline ? (
        <textarea
          className="forms-field__textarea"
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={readOnly}
          aria-label={field.name}
          maxLength={field.flags.maxLen ?? undefined}
          rows={3}
        />
      ) : (
        <TextInput
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={readOnly}
          aria-label={field.name}
          maxLength={field.flags.maxLen ?? undefined}
        />
      )}
      {title !== field.name && <span className="sr-only">{title}</span>}
    </Field>
  );
}
