import type { ReactNode } from 'react';
import clsx from 'clsx';
import { FilePlus, TriangleAlert, Workflow, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from './Button';
import { Dialog, DialogSpacer } from './Dialog';
import { Collapsible, Field, RadioGroup, Select, type SelectOption } from './Form';
import { ProgressBar } from './Misc';
import { basename } from '../lib/path';
import { useUi } from '../app/state/ui';
import './TaskDialog.css';

export type ApplyTo = 'this' | 'multiple';

export interface TaskPreset<V extends string = string> {
  value: V;
  options: SelectOption<V>[];
  onChange(value: V): void;
  /** Buttons next to the preset select (save / delete a preset). */
  actions?: ReactNode;
}

export interface TaskApplyTo {
  value: ApplyTo;
  onChange(value: ApplyTo): void;
  /** Extra files when value = 'multiple'. */
  files: string[];
  onAddFiles(): void;
  onRemoveFile(path: string): void;
  /** Disable the "this file" choice (e.g. no document open). */
  thisDisabled?: boolean;
  multipleDisabled?: boolean;
}

export interface TaskDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  icon?: ReactNode;
  description?: ReactNode;
  preset?: TaskPreset;
  /** Main options (3–4). */
  children: ReactNode;
  /** Shown inside the collapsible "Advanced" section. */
  advanced?: ReactNode;
  preview?: ReactNode;
  estimate?: ReactNode;
  warnings?: string[];
  applyTo?: TaskApplyTo;
  runLabel?: string;
  onRun(): void;
  /** A ready-to-save operation step for the workflow builder. */
  workflowStep?: { op: string; params: Record<string, unknown>; label?: string };
  canRun?: boolean;
  running?: boolean;
  /** 0..1 or null (indeterminate), shown while running. */
  progress?: number | null;
  onCancelRun?(): void;
  size?: 'md' | 'lg' | 'xl';
  /** Width of the preview column in px (default 300). */
  sideWidth?: number;
}

/**
 * Shared dialog layout for every processing feature (BLUEPRINT §6):
 * preset, main options, advanced, preview + estimate, warnings, apply-to, Cancel/Run.
 */
export function TaskDialog({
  open,
  onOpenChange,
  title,
  icon,
  description,
  preset,
  children,
  advanced,
  preview,
  estimate,
  warnings,
  applyTo,
  runLabel,
  onRun,
  workflowStep,
  canRun = true,
  running,
  progress,
  onCancelRun,
  size,
  sideWidth,
}: TaskDialogProps) {
  const { t } = useTranslation();
  const openDialog = useUi((state) => state.openDialog);
  const hasSide = preview !== undefined || estimate !== undefined;
  const splitStyle =
    sideWidth !== undefined ? { gridTemplateColumns: `minmax(0, 1fr) ${sideWidth}px` } : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !running && onOpenChange(o)}
      title={title}
      icon={icon}
      description={description}
      size={size ?? (hasSide ? 'xl' : 'lg')}
      modalLock={running}
      footer={
        <>
          {applyTo && (
            <div className="task__apply">
              <span className="task__apply-label">{t('task.applyTo')}</span>
              <RadioGroup
                className="task__apply-radios"
                aria-label={t('task.applyTo')}
                value={applyTo.value}
                onChange={applyTo.onChange}
                options={[
                  { value: 'this', label: t('task.thisFile'), disabled: applyTo.thisDisabled },
                  {
                    value: 'multiple',
                    label: t('task.multipleFiles'),
                    disabled: applyTo.multipleDisabled,
                  },
                ]}
              />
            </div>
          )}
          <DialogSpacer />
          <Button
            variant="ghost"
            icon={<Workflow size={15} />}
            disabled={!workflowStep || running}
            onClick={() => workflowStep && openDialog('workflow', { workflowStep })}
            className="task__save-step"
          >
            {t('task.saveAsStep')}
          </Button>
          {running && onCancelRun ? (
            <Button onClick={onCancelRun}>{t('task.stop')}</Button>
          ) : (
            <Button onClick={() => onOpenChange(false)} disabled={running}>
              {t('common.cancel')}
            </Button>
          )}
          <Button variant="primary" onClick={onRun} disabled={!canRun} loading={running}>
            {runLabel ?? t('task.run')}
          </Button>
        </>
      }
    >
      <div className={clsx('task', hasSide && 'task--split')} style={splitStyle}>
        <div className="task__main">
          {preset && (
            <Field label={t('task.preset')}>
              <div className="task__preset-row">
                <Select
                  value={preset.value}
                  onChange={preset.onChange}
                  options={preset.options}
                  aria-label={t('task.preset')}
                />
                {preset.actions}
              </div>
            </Field>
          )}
          <div className="task__options">{children}</div>
          {applyTo?.value === 'multiple' && (
            <div className="task__files">
              <div className="field__label">{t('task.files')}</div>
              {applyTo.files.length === 0 && <div className="field__hint">{t('task.noFiles')}</div>}
              <ul className="task__file-list">
                {applyTo.files.map((f) => (
                  <li key={f}>
                    <span className="task__file-name" title={f}>
                      {basename(f)}
                    </span>
                    <IconButton
                      size="sm"
                      label={t('common.remove')}
                      icon={<X size={14} />}
                      onClick={() => applyTo.onRemoveFile(f)}
                    />
                  </li>
                ))}
              </ul>
              <Button size="sm" icon={<FilePlus size={14} />} onClick={applyTo.onAddFiles}>
                {t('task.addFiles')}
              </Button>
            </div>
          )}
          {advanced && (
            <div className="task__advanced">
              <Collapsible label={t('task.advanced')}>{advanced}</Collapsible>
            </div>
          )}
        </div>
        {hasSide && (
          <aside className="task__side">
            {preview !== undefined && (
              <section className="task__preview" aria-label={t('task.preview')}>
                <div className="task__side-title">{t('task.preview')}</div>
                {preview}
              </section>
            )}
            {estimate !== undefined && (
              <div className="task__estimate">
                <span className="muted">{t('task.estimate')}</span> {estimate}
              </div>
            )}
          </aside>
        )}
      </div>
      {warnings && warnings.length > 0 && (
        <ul className="task__warnings" role="alert">
          {warnings.map((w) => (
            <li key={w}>
              <TriangleAlert size={15} aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      )}
      {running && (
        <div className="task__progress">
          <ProgressBar value={progress ?? null} label={t('jobs.running')} />
        </div>
      )}
    </Dialog>
  );
}
