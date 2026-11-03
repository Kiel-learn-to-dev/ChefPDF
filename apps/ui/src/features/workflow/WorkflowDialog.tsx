import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ArrowUp,
  FilePlus2,
  FolderOpen,
  Play,
  Plus,
  Save,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import type {
  OpDescriptor,
  Workflow,
  WorkflowFileResult,
  WorkflowIssue,
  WorkflowSample,
  WorkflowStep,
  WorkflowValidationResult,
  WorkflowRunResult,
  WorkflowSamplesResult,
} from '@chef/contracts';
import { Button, IconButton } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Select, TextInput } from '../../components/Form';
import { toast } from '../../components/Toast';
import { chef } from '../../lib/bridge';
import { call, runOp } from '../../lib/rpc';
import { showError } from '../../app/actions';
import { hasWorkflowDataRisk, needsMoreWorkflowFiles } from '../start/startWorkflowModel';
import { useUi } from '../../app/state/ui';
import {
  buildWorkflowOutputOverride,
  formatWorkflowJson,
  createWorkflow,
  moveWorkflowStep,
  removeWorkflowStep,
  parseWorkflowJson,
} from './workflowModel';
import './workflow.css';

const JSON_FILTERS = [{ name: 'JSON workflow', extensions: ['json'] }];
const PDF_FILTERS = [{ name: 'PDF', extensions: ['pdf'] }];
type SecretValues = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function WorkflowDialog() {
  const { t } = useTranslation();
  const close = useUi((state) => state.closeDialog);
  const dialogData = useUi((state) => state.dialogData) as
    | {
        workflowStep?: WorkflowStep;
        sample?: WorkflowSample;
        files?: string[];
        result?: WorkflowRunResult;
      }
    | undefined;
  const initialStep = dialogData?.workflowStep;
  const sample = dialogData?.sample;
  const [workflow, setWorkflow] = useState<Workflow>(
    () => sample?.workflow ?? createWorkflow(initialStep),
  );
  const [stepKeys, setStepKeys] = useState<string[]>(() =>
    sample ? sample.workflow.steps.map((_, i) => `initial-${i}`) : initialStep ? ['step-seed'] : [],
  );
  const [descriptors, setDescriptors] = useState<OpDescriptor[]>([]);
  const [samples, setSamples] = useState<WorkflowSample[]>([]);
  const [selectedSample, setSelectedSample] = useState(sample?.id ?? '');
  const [files, setFiles] = useState<string[]>(() => dialogData?.files ?? []);
  const [filePasswords, setFilePasswords] = useState<SecretValues>({});
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [runResult, setRunResult] = useState<WorkflowRunResult | null>(dialogData?.result ?? null);
  const [variables, setVariables] = useState<SecretValues>(() => sample?.workflow.variables ?? {});
  const [secrets, setSecrets] = useState<SecretValues>({});
  const [outputMode, setOutputMode] = useState<'suffix' | 'folder' | 'overwrite'>(
    sample?.workflow.output?.mode ?? 'suffix',
  );
  const [suffix, setSuffix] = useState(sample?.workflow.output?.suffix ?? '_da-xu-ly');
  const [folder, setFolder] = useState(sample?.workflow.output?.folder ?? '');
  const [nameTemplate, setNameTemplate] = useState(sample?.workflow.output?.nameTemplate ?? '');
  const [addOp, setAddOp] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [paramDrafts, setParamDrafts] = useState<Record<string, string>>({});
  const keyCounter = useRef(0);
  const nextStepKey = () => `step-${++keyCounter.current}`;
  const invalidParams = Object.values(paramErrors).some(Boolean);
  const hasTransformSteps = hasWorkflowDataRisk(workflow);
  const mergesInputs = workflow.inputs?.mode === 'merge';
  const outputOverride = () =>
    buildWorkflowOutputOverride(workflow.output, {
      mode: outputMode,
      suffix,
      folder,
      nameTemplate,
    });
  const workflowWithOutput = () => ({ ...workflow, output: outputOverride() });

  useEffect(() => {
    void Promise.all([
      call('ops.list', {}),
      runOp('workflow.samples', {}, { title: t('workflow.sample'), silent: true }),
    ])
      .then(([ops, sampleOutput]) => {
        setDescriptors(
          ops.filter((op) => !op.standalone && op.group !== 'workflow' && op.group !== 'batch'),
        );
        const data = sampleOutput.data as WorkflowSamplesResult | undefined;
        setSamples(Array.isArray(data?.samples) ? data.samples : []);
      })
      .catch((error: unknown) => showError(error, t('workflow.samplesFailed')));
  }, [t]);

  const sampleOptions = useMemo(
    () => [
      { value: '', label: t('workflow.sample') },
      ...samples.map((sample) => ({ value: sample.id, label: sample.name })),
    ],
    [samples, t],
  );
  const operationOptions = useMemo(
    () => descriptors.map((op) => ({ value: op.id, label: `${op.title} · ${op.id}` })),
    [descriptors],
  );
  const stepIssues = (issues: WorkflowIssue[]) => issues.filter((issue) => issue.step !== null);
  const changeOutput = <K extends 'mode' | 'suffix' | 'folder' | 'nameTemplate'>(
    key: K,
    value: string,
  ) => {
    if (key === 'mode') setOutputMode(value as typeof outputMode);
    else if (key === 'suffix') setSuffix(value);
    else if (key === 'folder') setFolder(value);
    else setNameTemplate(value);
    setValidation(null);
  };

  const validate = async () => {
    if (invalidParams) {
      toast.error(t('workflow.jsonError'));
      return null;
    }
    setBusy(true);
    setRunResult(null);
    try {
      const output = await runOp(
        'workflow.validate',
        { workflow: workflowWithOutput() as unknown as Record<string, unknown>, variables },
        { title: t('workflow.validate') },
      );
      const data = output.data as WorkflowValidationResult;
      setValidation(data);
      setVariables((current) =>
        Object.fromEntries(
          data.requiredVariables.map((key) => [
            key,
            current[key] ?? workflow.variables?.[key] ?? '',
          ]),
        ),
      );
      setSecrets((current) =>
        Object.fromEntries(data.requiredSecrets.map((key) => [key, current[key] ?? ''])),
      );
      return data;
    } catch (error) {
      showError(error, t('workflow.validationFailed'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (invalidParams) {
      toast.error(t('workflow.jsonError'));
      return;
    }
    if (!files.length) {
      toast.error(t('workflow.noFiles'));
      return;
    }
    if (needsMoreWorkflowFiles(workflow, files.length)) {
      toast.error(t('workflow.mergeNeedsTwo'));
      return;
    }
    setBusy(true);
    try {
      let report = validation;
      if (!report || !report.valid) {
        const output = await runOp(
          'workflow.validate',
          { workflow: workflowWithOutput() as unknown as Record<string, unknown>, variables },
          { title: t('workflow.validate') },
        );
        report = output.data as WorkflowValidationResult;
        setValidation(report);
        setVariables((current) =>
          Object.fromEntries(
            report!.requiredVariables.map((key) => [
              key,
              current[key] ?? workflow.variables?.[key] ?? '',
            ]),
          ),
        );
        setSecrets((current) =>
          Object.fromEntries(report!.requiredSecrets.map((key) => [key, current[key] ?? ''])),
        );
      }
      if (!report.valid) {
        toast.error(t('workflow.invalid'));
        return;
      }
      if (
        report.requiredVariables.some((key) => !variables[key]?.trim()) ||
        report.requiredSecrets.some((key) => !secrets[key])
      ) {
        toast.error(t('workflow.invalid'));
        return;
      }
      const output = await runOp(
        'workflow.run',
        {
          workflow: workflowWithOutput() as unknown as Record<string, unknown>,
          files: files.map((path) => ({
            path,
            ...(filePasswords[path] ? { password: filePasswords[path] } : {}),
          })),
          variables,
          secrets,
          output: outputOverride(),
        },
        { title: t('workflow.run') },
      );
      setRunResult(output.data as WorkflowRunResult);
      toast.success(t('workflow.results'));
    } catch (error) {
      showError(error, t('workflow.runFailed'));
    } finally {
      setBusy(false);
    }
  };

  const loadSample = (id: string) => {
    setSelectedSample(id);
    const sample = samples.find((item) => item.id === id);
    if (!sample) return;
    setWorkflow(sample.workflow);
    setStepKeys(sample.workflow.steps.map(() => nextStepKey()));
    setParamDrafts({});
    setParamErrors({});
    setOutputMode(sample.workflow.output?.mode ?? 'suffix');
    setSuffix(sample.workflow.output?.suffix ?? '_da-xu-ly');
    setFolder(sample.workflow.output?.folder ?? '');
    setNameTemplate(sample.workflow.output?.nameTemplate ?? '');
    setVariables(sample.workflow.variables ?? {});
    setValidation(null);
    setRunResult(null);
  };

  const openWorkflow = async () => {
    try {
      const [path] = await chef().files.openDialog({ multiple: false, filters: JSON_FILTERS });
      if (!path) return;
      const loaded = parseWorkflowJson(await chef().files.readText(path));
      setWorkflow(loaded);
      setStepKeys(loaded.steps.map(() => nextStepKey()));
      setVariables(loaded.variables ?? {});
      setOutputMode(loaded.output?.mode ?? 'suffix');
      setSuffix(loaded.output?.suffix ?? '_da-xu-ly');
      setFolder(loaded.output?.folder ?? '');
      setNameTemplate(loaded.output?.nameTemplate ?? '');
      setParamDrafts({});
      setParamErrors({});
      setValidation(null);
      setRunResult(null);
      setSelectedSample('');
    } catch (error) {
      showError(error, t('workflow.loadFailed'));
    }
  };

  const saveWorkflow = async () => {
    if (invalidParams) {
      toast.error(t('workflow.jsonError'));
      return;
    }
    const report = await validate();
    if (!report) return;
    if (report.errors.some((issue) => issue.kind === 'SECRET_LITERAL')) {
      toast.error(t('workflow.secretLiteral'));
      return;
    }
    try {
      const path = await chef().files.saveDialog({
        defaultPath: `${workflow.id}.json`,
        filters: JSON_FILTERS,
      });
      if (!path) return;
      await chef().files.writeText(path, formatWorkflowJson(workflowWithOutput()));
      toast.success(t(report.valid ? 'workflow.save' : 'workflow.savedDraft'));
    } catch (error) {
      showError(error, t('workflow.saveFailed'));
    }
  };

  const addStep = () => {
    if (!addOp) return;
    setStepKeys((keys) => [...keys, nextStepKey()]);
    setWorkflow((current) => ({
      ...current,
      steps: [
        ...current.steps,
        { op: addOp, params: {}, ...(addLabel ? { label: addLabel } : {}) },
      ],
    }));
    setValidation(null);
    setAddLabel('');
  };

  const updateStep = (index: number, patch: Partial<WorkflowStep>) => {
    setWorkflow((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
    setValidation(null);
  };

  const editParams = (stepKey: string, index: number, value: string) => {
    setParamDrafts((all) => ({ ...all, [stepKey]: value }));
    try {
      const params: unknown = JSON.parse(value);
      if (!isRecord(params)) throw new Error();
      updateStep(index, { params });
      setParamErrors((all) => ({ ...all, [stepKey]: '' }));
    } catch {
      setParamErrors((all) => ({ ...all, [stepKey]: t('workflow.jsonError') }));
    }
  };

  const chooseFiles = async () => {
    try {
      const paths = await chef().files.openDialog({ multiple: true, filters: PDF_FILTERS });
      if (paths.length) setFiles((current) => [...new Set([...current, ...paths])]);
    } catch (error) {
      showError(error, t('workflow.noFiles'));
    }
  };

  const issues = validation ? [...validation.errors, ...validation.warnings] : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      title={t('workflow.title')}
      description={t('workflow.description')}
      icon={<WorkflowIcon size={18} />}
      size="xl"
      className="workflow-dialog"
    >
      <div className="workflow-editor">
        <div className="workflow-toolbar">
          <Button
            size="sm"
            variant="ghost"
            icon={<FilePlus2 size={15} />}
            onClick={() => {
              setWorkflow(createWorkflow());
              setStepKeys([]);
              setParamDrafts({});
              setParamErrors({});
              setValidation(null);
              setRunResult(null);
              setSelectedSample('');
              setVariables({});
            }}
          >
            {t('workflow.new')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={15} />}
            onClick={() => void openWorkflow()}
          >
            {t('workflow.load')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Save size={15} />}
            onClick={() => void saveWorkflow()}
          >
            {t('workflow.save')}
          </Button>
          <div className="workflow-toolbar__sample">
            <Select
              value={selectedSample}
              onChange={loadSample}
              options={sampleOptions}
              aria-label={t('workflow.sample')}
            />
          </div>
        </div>

        <div className="workflow-grid">
          {hasTransformSteps && (
            <p className="workflow-overwrite-warning" role="alert">
              {t('workflow.transformWarning')}
            </p>
          )}
          <section className="workflow-main">
            <div className="workflow-meta">
              <Field label={t('workflow.name')} htmlFor="workflow-name">
                <TextInput
                  id="workflow-name"
                  value={workflow.name}
                  onChange={(e) => setWorkflow({ ...workflow, name: e.target.value })}
                />
              </Field>
              <Field label={t('workflow.id')} htmlFor="workflow-id">
                <TextInput
                  id="workflow-id"
                  value={workflow.id}
                  onChange={(e) => setWorkflow({ ...workflow, id: e.target.value })}
                />
              </Field>
            </div>
            <div className="workflow-section-title">
              <h3>{t('workflow.steps')}</h3>
              <span>{workflow.steps.length}</span>
            </div>
            {!workflow.steps.length && <p className="workflow-empty">{t('workflow.noSteps')}</p>}
            <ol className="workflow-steps">
              {workflow.steps.map((step, index) => {
                const stepKey = stepKeys[index] ?? `${workflow.id}-${index}`;
                return (
                  <li className="workflow-step" key={stepKey}>
                    <div className="workflow-step__head">
                      <span className="workflow-step__number">{index + 1}</span>
                      <strong>
                        {descriptors.find((op) => op.id === step.op)?.title ?? step.op}
                      </strong>
                      <div className="workflow-step__actions">
                        <IconButton
                          size="sm"
                          label={t('workflow.moveUp')}
                          icon={<ArrowUp size={14} />}
                          disabled={index === 0}
                          onClick={() => {
                            setWorkflow((current) => ({
                              ...current,
                              steps: moveWorkflowStep(current.steps, index, -1),
                            }));
                            setStepKeys((keys) => moveWorkflowStep(keys, index, -1));
                            setValidation(null);
                          }}
                        />
                        <IconButton
                          size="sm"
                          label={t('workflow.moveDown')}
                          icon={<ArrowDown size={14} />}
                          disabled={index === workflow.steps.length - 1}
                          onClick={() => {
                            setWorkflow((current) => ({
                              ...current,
                              steps: moveWorkflowStep(current.steps, index, 1),
                            }));
                            setStepKeys((keys) => moveWorkflowStep(keys, index, 1));
                            setValidation(null);
                          }}
                        />
                        <IconButton
                          size="sm"
                          label={t('workflow.remove')}
                          icon={<Trash2 size={14} />}
                          onClick={() => {
                            setWorkflow((current) => ({
                              ...current,
                              steps: removeWorkflowStep(current.steps, index),
                            }));
                            setStepKeys((keys) => removeWorkflowStep(keys, index));
                            setParamDrafts((drafts) => {
                              const next = { ...drafts };
                              delete next[stepKey];
                              return next;
                            });
                            setParamErrors((errors) => {
                              const next = { ...errors };
                              delete next[stepKey];
                              return next;
                            });
                            setValidation(null);
                          }}
                        />
                      </div>
                    </div>
                    <div className="workflow-step__fields">
                      <TextInput
                        aria-label={t('workflow.operation')}
                        value={step.op}
                        onChange={(e) => updateStep(index, { op: e.target.value })}
                      />
                      <TextInput
                        aria-label={t('workflow.name')}
                        value={step.label ?? ''}
                        placeholder={t('workflow.name')}
                        onChange={(e) => updateStep(index, { label: e.target.value || null })}
                      />
                    </div>
                    <Field label={t('workflow.params')} error={paramErrors[stepKey]}>
                      <textarea
                        className="workflow-json"
                        aria-label={`${t('workflow.params')} ${index + 1}`}
                        value={paramDrafts[stepKey] ?? JSON.stringify(step.params ?? {}, null, 2)}
                        onChange={(e) => editParams(stepKey, index, e.target.value)}
                        spellCheck={false}
                      />
                    </Field>
                    <div className="workflow-step__options">
                      <label>
                        <input
                          type="checkbox"
                          checked={step.enabled !== false}
                          onChange={(e) => updateStep(index, { enabled: e.target.checked })}
                        />{' '}
                        {t('workflow.enabled', { defaultValue: 'Enabled' })}
                      </label>
                      <label>
                        {t('workflow.onError', { defaultValue: 'On error' })}
                        <select
                          value={step.onError ?? 'stop'}
                          onChange={(e) =>
                            updateStep(index, { onError: e.target.value as 'stop' | 'skip' })
                          }
                        >
                          <option value="stop">stop</option>
                          <option value="skip">skip</option>
                        </select>
                      </label>
                    </div>
                    {validation?.steps[index] && (
                      <p className="workflow-step__description">
                        {validation.steps[index].description}
                      </p>
                    )}
                    {stepIssues(issues)
                      .filter((issue) => issue.step === index)
                      .map((issue, i) => (
                        <p
                          className={`workflow-issue workflow-issue--${validation?.errors.includes(issue) ? 'error' : 'warning'}`}
                          key={`${issue.kind}-${i}`}
                        >
                          {issue.message}
                        </p>
                      ))}
                  </li>
                );
              })}
            </ol>
            <div className="workflow-add">
              <TextInput
                list="workflow-operation-list"
                value={addOp}
                onChange={(e) => setAddOp(e.target.value)}
                placeholder={t('workflow.operation')}
                aria-label={t('workflow.operation')}
              />
              <datalist id="workflow-operation-list">
                {operationOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
              <TextInput
                value={addLabel}
                onChange={(e) => setAddLabel(e.target.value)}
                placeholder={t('workflow.name')}
                aria-label={t('workflow.name')}
              />
              <Button size="sm" icon={<Plus size={15} />} onClick={addStep} disabled={!addOp}>
                {t('workflow.addStep')}
              </Button>
            </div>
          </section>

          <aside className="workflow-side">
            <section className="workflow-panel">
              <h3>{t('workflow.files')}</h3>
              <Button
                size="sm"
                variant="secondary"
                icon={<FilePlus2 size={14} />}
                onClick={() => void chooseFiles()}
              >
                {t('workflow.chooseFiles')}
              </Button>
              {mergesInputs && (
                <p className="muted" role="note">
                  {t('workflow.mergeInputsHint')}
                </p>
              )}
              {files.length === 0 ? (
                <p className="muted">{t('workflow.noFiles')}</p>
              ) : (
                <ul className="workflow-files">
                  {files.map((path, index) => (
                    <li key={path}>
                      <span title={path}>{path.split(/[\\/]/).at(-1)}</span>
                      {workflow.inputs?.password && (
                        <TextInput
                          type="password"
                          value={filePasswords[path] ?? ''}
                          onChange={(e) =>
                            setFilePasswords({ ...filePasswords, [path]: e.target.value })
                          }
                          aria-label={`${t('workflow.filePassword')} ${path.split(/[\\/]/).at(-1)}`}
                          autoComplete="new-password"
                        />
                      )}
                      <IconButton
                        size="sm"
                        label={t('workflow.moveFileUp')}
                        icon={<ArrowUp size={13} />}
                        disabled={index === 0}
                        onClick={() =>
                          setFiles((current) => {
                            const next = [...current];
                            const earlier = next[index - 1]!;
                            next[index - 1] = next[index]!;
                            next[index] = earlier;
                            return next;
                          })
                        }
                      />
                      <IconButton
                        size="sm"
                        label={t('workflow.moveFileDown')}
                        icon={<ArrowDown size={13} />}
                        disabled={index === files.length - 1}
                        onClick={() =>
                          setFiles((current) => {
                            const next = [...current];
                            const later = next[index + 1]!;
                            next[index + 1] = next[index]!;
                            next[index] = later;
                            return next;
                          })
                        }
                      />
                      <IconButton
                        size="sm"
                        label={t('common.remove')}
                        icon={<Trash2 size={13} />}
                        onClick={() => {
                          setFiles((current) => current.filter((f) => f !== path));
                          setFilePasswords((current) => {
                            const next = { ...current };
                            delete next[path];
                            return next;
                          });
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="workflow-panel">
              <h3>{t('workflow.output', { defaultValue: 'Output' })}</h3>
              <Field label={t('workflow.outputMode')}>
                <Select
                  value={outputMode}
                  onChange={(value) => changeOutput('mode', value)}
                  options={[
                    { value: 'suffix', label: t('workflow.modeSuffix') },
                    { value: 'folder', label: t('workflow.modeFolder') },
                    { value: 'overwrite', label: t('workflow.modeOverwrite') },
                  ]}
                />
              </Field>
              {outputMode === 'suffix' && (
                <Field label={t('workflow.suffix')}>
                  <TextInput
                    value={suffix}
                    onChange={(e) => changeOutput('suffix', e.target.value)}
                  />
                </Field>
              )}
              {outputMode === 'folder' && (
                <Field label={t('workflow.folder')}>
                  <TextInput
                    value={folder}
                    onChange={(e) => changeOutput('folder', e.target.value)}
                  />
                </Field>
              )}
              <Field label={t('workflow.nameTemplate')} hint={t('workflow.nameTemplateHint')}>
                <TextInput
                  value={nameTemplate}
                  onChange={(e) => changeOutput('nameTemplate', e.target.value)}
                  placeholder="{name}_{firstline}"
                />
              </Field>
              {outputMode === 'overwrite' && (
                <p className="workflow-overwrite-warning" role="alert">
                  {t('workflow.overwriteWarning')}
                </p>
              )}
            </section>
            <div className="workflow-actions">
              <Button
                variant="secondary"
                onClick={() => void validate()}
                disabled={busy || workflow.steps.length === 0 || invalidParams}
              >
                {t('workflow.validate')}
              </Button>
              <Button
                variant="primary"
                icon={<Play size={15} />}
                onClick={() => void run()}
                disabled={
                  busy ||
                  workflow.steps.length === 0 ||
                  files.length === 0 ||
                  invalidParams ||
                  needsMoreWorkflowFiles(workflow, files.length)
                }
              >
                {t('workflow.run')}
              </Button>
            </div>
            {validation && (
              <section
                className={`workflow-validation ${validation.valid ? 'is-valid' : 'is-invalid'}`}
                role="status"
              >
                <strong>{validation.valid ? t('workflow.valid') : t('workflow.invalid')}</strong>
                {validation.errors.map((issue, i) => (
                  <p className="workflow-issue workflow-issue--error" key={`error-${i}`}>
                    {issue.step !== null ? `B${issue.step + 1} · ` : ''}
                    {issue.message}
                  </p>
                ))}
                {validation.warnings.map((issue, i) => (
                  <p className="workflow-issue workflow-issue--warning" key={`warning-${i}`}>
                    {issue.step !== null ? `B${issue.step + 1} · ` : ''}
                    {issue.message}
                  </p>
                ))}
                {validation.requiredVariables.map((key) => (
                  <Field key={key} label={`{{${key}}}`}>
                    <TextInput
                      value={variables[key] ?? ''}
                      onChange={(e) => setVariables({ ...variables, [key]: e.target.value })}
                    />
                  </Field>
                ))}
                {validation.requiredSecrets.map((key) => (
                  <Field key={key} label={`🔒 ${key}`}>
                    <TextInput
                      type="password"
                      value={secrets[key] ?? ''}
                      onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
                      autoComplete="new-password"
                    />
                  </Field>
                ))}
              </section>
            )}
            {runResult && (
              <section className="workflow-validation" aria-label={t('workflow.results')}>
                <h3>{t('workflow.results')}</h3>
                <p>{t('workflow.doneCount', { ...runResult.summary })}</p>
                <ul className="workflow-results">
                  {runResult.results.map((result: WorkflowFileResult) => (
                    <li key={result.path}>
                      <strong>
                        {result.status === 'done'
                          ? t('workflow.resultDone')
                          : result.status === 'failed'
                            ? t('workflow.resultFailed')
                            : t('workflow.resultSkipped')}
                      </strong>
                      <span title={result.path}>{result.path.split(/[\\/]/).at(-1)}</span>
                      {result.message && <p>{result.message}</p>}
                      {result.outputs.length > 0 && (
                        <p>
                          {t('workflow.outputs')}: {result.outputs.join(', ')}
                        </p>
                      )}
                      {result.warnings.map((warning, i) => (
                        <p className="workflow-issue workflow-issue--warning" key={i}>
                          {warning}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      </div>
    </Dialog>
  );
}
