import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { Checkbox, Field, Select, TextInput } from '../../components/Form';
import {
  createIssue,
  createParams,
  DEFAULT_CREATE_FORM,
  FORM_KINDS,
  type CreateFormDraft,
  type PendingFormRect,
} from './formsModel';

export function CreateFieldForm({
  pending,
  existingNames,
  busy,
  onCancel,
  onCreate,
}: {
  pending: PendingFormRect;
  existingNames: string[];
  busy: boolean;
  onCancel(): void;
  onCreate(params: NonNullable<ReturnType<typeof createParams>>): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<CreateFormDraft>(DEFAULT_CREATE_FORM);
  const issue = createIssue(draft, pending);
  const duplicate = existingNames.includes(draft.name.trim());
  const params = duplicate ? null : createParams(draft, pending);
  const set = (patch: Partial<CreateFormDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const typeOptions = FORM_KINDS.map((kind) => ({ value: kind, label: t(`forms.kind.${kind}`) }));

  return (
    <div className="forms-create">
      <p className="forms-create__placement">
        {t('forms.placement', {
          page: pending.pageIndex + 1,
          rect: pending.rect.map((value) => Math.round(value)).join(', '),
        })}
      </p>
      <Field label={t('forms.kindLabel')}>
        <Select value={draft.kind} onChange={(kind) => set({ kind })} options={typeOptions} />
      </Field>
      <Field
        label={t('forms.name')}
        htmlFor="form-field-name"
        error={
          duplicate
            ? t('forms.issues.duplicate')
            : issue === 'name'
              ? t('forms.issues.name')
              : undefined
        }
      >
        <TextInput
          id="form-field-name"
          value={draft.name}
          onChange={(event) => set({ name: event.target.value })}
          disabled={busy}
          invalid={duplicate || issue === 'name'}
          autoFocus
        />
      </Field>
      <Field label={t('forms.tooltip')} htmlFor="form-field-tooltip">
        <TextInput
          id="form-field-tooltip"
          value={draft.label}
          onChange={(event) => set({ label: event.target.value })}
          disabled={busy}
        />
      </Field>
      {(draft.kind === 'radio' || draft.kind === 'dropdown') && (
        <Field
          label={t('forms.options')}
          htmlFor="form-field-options"
          hint={t('forms.optionsHint')}
          error={
            issue === 'options'
              ? t('forms.issues.options')
              : issue === 'radioSize'
                ? t('forms.issues.radioSize')
                : undefined
          }
        >
          <textarea
            id="form-field-options"
            className="forms-field__textarea"
            value={draft.optionsText}
            onChange={(event) => set({ optionsText: event.target.value })}
            disabled={busy}
            rows={3}
          />
        </Field>
      )}
      {draft.kind === 'comb' && (
        <Field
          label={t('forms.maxLength')}
          htmlFor="form-field-max-len"
          error={issue === 'maxLen' ? t('forms.issues.maxLen') : undefined}
        >
          <TextInput
            id="form-field-max-len"
            type="number"
            min={1}
            max={100000}
            value={draft.maxLenText}
            onChange={(event) => set({ maxLenText: event.target.value })}
            disabled={busy}
          />
        </Field>
      )}
      <Checkbox
        checked={draft.required}
        onChange={(required) => set({ required })}
        label={t('forms.requiredFlag')}
        disabled={busy}
      />
      <div className="forms-create__actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={!params || busy}
          loading={busy}
          onClick={() => params && onCreate(params)}
        >
          {t('forms.create')}
        </Button>
      </div>
    </div>
  );
}
