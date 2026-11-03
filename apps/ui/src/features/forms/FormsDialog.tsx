import { useCallback, useEffect, useState } from 'react';
import { FileCheck2, Plus, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useActiveDoc } from '../../app/state/documents';
import { useUi } from '../../app/state/ui';
import { runDocOp } from '../../app/actions';
import { confirmDialog } from '../../app/prompts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { FieldEditor } from './FieldEditor';
import { CreateFieldForm } from './CreateFieldForm';
import { useFormDraw } from './formDrawState';
import { readFormFields, type FormField, type FormValue } from './formsModel';
import { runOp } from '../../lib/rpc';
import { addFieldsSequentially } from './formsOperations';

export function FormsDialog() {
  const { t } = useTranslation();
  const doc = useActiveDoc();
  const close = useUi((s) => s.closeDialog);
  const pending = useFormDraw((s) => s.pending);
  const [fields, setFields] = useState<FormField[]>([]);
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!doc) return;
    setLoading(true);
    try {
      const [list, vals] = await Promise.all([
        runOp('forms.list', {}, { sessionId: doc.id, title: t('forms.title'), silent: true }),
        runOp('forms.getValues', {}, { sessionId: doc.id, title: t('forms.title'), silent: true }),
      ]);
      setFields(readFormFields(list.data).fields);
      const raw = (vals.data as { values?: Record<string, FormValue> } | undefined)?.values;
      setValues(raw && typeof raw === 'object' ? raw : {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [doc, t]);

  useEffect(() => {
    if (!doc) return;
    let active = true;
    void Promise.all([
      runOp('forms.list', {}, { sessionId: doc.id, title: t('forms.title'), silent: true }),
      runOp('forms.getValues', {}, { sessionId: doc.id, title: t('forms.title'), silent: true }),
    ])
      .then(([list, vals]) => {
        if (!active) return;
        setFields(readFormFields(list.data).fields);
        const raw = (vals.data as { values?: Record<string, FormValue> } | undefined)?.values;
        setValues(raw && typeof raw === 'object' ? raw : {});
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [doc, t]);
  if (!doc) return null;
  const mutate = async (
    op: 'forms.fill' | 'forms.addField' | 'forms.flatten' | 'forms.remove',
    params: never,
  ) => {
    setBusy(true);
    try {
      const result = await runDocOp(doc.id, op, params, t('forms.title'));
      if (result) await reload();
      return !!result;
    } finally {
      setBusy(false);
    }
  };
  const create = async (
    params: Parameters<typeof CreateFieldForm>[0]['onCreate'] extends (p: infer P) => void
      ? P
      : never,
  ) => {
    setError(null);
    const result = await addFieldsSequentially(
      params,
      (param) => mutate('forms.addField', param as never),
      (name) => mutate('forms.remove', { names: [name] } as never),
    );
    if (result.success) {
      useFormDraw.getState().setPending(null);
      await reload();
    } else if (params.length > 1) {
      setError(
        t(result.rolledBack ? 'forms.radioCreateFailed' : 'forms.radioRollbackFailed', {
          completed: result.completed,
          total: params.length,
        }),
      );
    }
  };
  const changed = Object.fromEntries(
    Object.entries(values).filter(([name, value]) => {
      const field = fields.find((f) => f.name === name);
      return (
        field &&
        (Array.isArray(value)
          ? JSON.stringify(value) !== JSON.stringify(field.value)
          : value !== field.value)
      );
    }),
  );
  const flatten = async () => {
    if (!fields.length || busy) return;
    const answer = await confirmDialog({
      title: t('forms.flattenConfirmTitle'),
      message: t('forms.flattenConfirmMessage'),
      tone: 'danger',
      actions: [
        { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
        { id: 'flatten', label: t('forms.flattenConfirmAction'), variant: 'danger' },
      ],
    });
    if (answer !== 'flatten') return;
    if (Object.keys(changed).length && !(await mutate('forms.fill', { values: changed } as never)))
      return;
    await mutate('forms.flatten', {} as never);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          if (pending) useFormDraw.getState().setPending(null);
          close();
        }
      }}
      title={t('forms.title')}
      icon={<FileCheck2 size={18} />}
      size="lg"
      modalLock={busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.close')}
          </Button>
          <span className="dlg__footer-spacer" />
          <Button
            variant="secondary"
            onClick={() => void flatten()}
            disabled={busy || !fields.length}
            icon={<Layers size={16} />}
          >
            {t('forms.flatten')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void mutate('forms.fill', { values: changed } as never)}
            disabled={busy || !Object.keys(changed).length}
          >
            {t('forms.apply')}
          </Button>
        </>
      }
    >
      {pending ? (
        <CreateFieldForm
          pending={pending}
          existingNames={fields.map((f) => f.name)}
          busy={busy}
          onCancel={() => {
            useFormDraw.getState().setPending(null);
            close();
          }}
          onCreate={(p) => void create(p)}
        />
      ) : (
        <>
          <div className="forms-toolbar">
            <span>{t('forms.count', { count: fields.length })}</span>
            <Button
              variant="secondary"
              onClick={() => {
                useFormDraw.getState().setPending(null);
                useFormDraw.getState().setDrawing(true);
                close();
              }}
              disabled={busy}
            >
              <Plus size={16} />
              {t('forms.addField')}
            </Button>
          </div>
          {loading && <p role="status">{t('forms.loading')}</p>}
          {error && (
            <p className="field__error" role="alert">
              {error}
            </p>
          )}
          {!loading && fields.length === 0 && <p className="muted">{t('forms.empty')}</p>}
          <div className="forms-list">
            {fields.map((field) => (
              <FieldEditor
                key={field.name}
                field={field}
                value={values[field.name] ?? field.value}
                disabled={busy}
                onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              />
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
