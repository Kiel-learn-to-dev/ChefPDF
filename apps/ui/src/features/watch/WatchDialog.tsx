import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Play, Square, Radio, AlertTriangle } from 'lucide-react';
import type {
  Workflow,
  WorkflowSample,
  WorkflowSamplesResult,
  WorkflowValidationResult,
} from '@chef/contracts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Field, Select, TextInput } from '../../components/Form';
import { chef } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { showError } from '../../app/actions';
import { useUi } from '../../app/state/ui';
import { parseWorkflowJson } from '../workflow/workflowModel';
import { useWatchStore } from './watchService';
import { validWatchConfig, type WatchConfig } from './watchModel';
import './watch.css';

type Values = Record<string, string>;

export function WatchDialog() {
  const { t } = useTranslation();
  const close = useUi((state) => state.closeDialog);
  const store = useWatchStore();
  const [samples, setSamples] = useState<WorkflowSample[]>([]);
  const [workflow, setWorkflow] = useState<Workflow | null>(store.config?.workflow ?? null);
  const [sourceFolder, setSource] = useState(store.config?.sourceFolder ?? '');
  const [outputFolder, setOutput] = useState(store.config?.outputFolder ?? '');
  const [pollSeconds, setPoll] = useState(store.config?.pollSeconds ?? 10);
  const [settleSeconds, setSettle] = useState(store.config?.settleSeconds ?? 3);
  const [pattern, setPattern] = useState(store.config?.pattern ?? '*.pdf');
  const [variables, setVariables] = useState<Values>({});
  const [secrets, setSecrets] = useState<Values>({});
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void runOp('workflow.samples', {}, { title: t('watch.title'), silent: true })
      .then((result) => setSamples((result.data as WorkflowSamplesResult).samples ?? []))
      .catch((error: unknown) => showError(error, t('watch.loadFailed')));
  }, [t]);

  const config: WatchConfig | null = workflow
    ? { sourceFolder, outputFolder, workflow, pollSeconds, settleSeconds, pattern }
    : null;
  const requiredVars = validation?.requiredVariables ?? [];
  const requiredSecrets = validation?.requiredSecrets ?? [];
  const options = useMemo(
    () => [
      { value: '', label: t('watch.chooseWorkflow') },
      ...samples.map((s) => ({ value: s.id, label: s.name })),
    ],
    [samples, t],
  );
  const active = store.status === 'running' || store.status === 'stopping';

  const chooseFolder = async (setter: (path: string) => void) => {
    try {
      const [path] = await chef().files.openDialog({ directory: true });
      if (path) setter(path);
    } catch (error) {
      showError(error, t('watch.folderError'));
    }
  };
  const validate = async () => {
    if (!workflow) return;
    setBusy(true);
    try {
      const result = await runOp(
        'workflow.validate',
        { workflow: workflow as unknown as Record<string, unknown>, variables },
        { title: t('watch.validate') },
      );
      const data = result.data as WorkflowValidationResult;
      setValidation(data);
      setVariables((old) =>
        Object.fromEntries(data.requiredVariables.map((key) => [key, old[key] ?? ''])),
      );
      setSecrets((old) =>
        Object.fromEntries(data.requiredSecrets.map((key) => [key, old[key] ?? ''])),
      );
    } catch (error) {
      showError(error, t('watch.validateFailed'));
    } finally {
      setBusy(false);
    }
  };
  const openWorkflow = async () => {
    try {
      const [path] = await chef().files.openDialog({
        multiple: false,
        filters: [{ name: 'JSON workflow', extensions: ['json'] }],
      });
      if (path) {
        setWorkflow(parseWorkflowJson(await chef().files.readText(path)));
        setValidation(null);
      }
    } catch (error) {
      showError(error, t('watch.loadFailed'));
    }
  };
  const start = async () => {
    if (!config || !validWatchConfig(config)) return;
    let report = validation;
    if (!report) {
      setBusy(true);
      try {
        const result = await runOp(
          'workflow.validate',
          { workflow: workflow as unknown as Record<string, unknown>, variables },
          { title: t('watch.validate') },
        );
        report = result.data as WorkflowValidationResult;
        setValidation(report);
        setVariables((old) =>
          Object.fromEntries(report!.requiredVariables.map((key) => [key, old[key] ?? ''])),
        );
        setSecrets((old) =>
          Object.fromEntries(report!.requiredSecrets.map((key) => [key, old[key] ?? ''])),
        );
      } catch (error) {
        showError(error, t('watch.validateFailed'));
        return;
      } finally {
        setBusy(false);
      }
    }
    if (
      !report.valid ||
      report.requiredVariables.some((key) => !variables[key]?.trim()) ||
      report.requiredSecrets.some((key) => !secrets[key])
    )
      return;
    store.start(config, variables, secrets);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      icon={<Radio size={18} />}
      title={t('watch.title')}
      description={t('watch.description')}
      size="lg"
      className="watch-dialog"
    >
      <div className="watch-layout">
        {store.interrupted && (
          <div className="watch-notice" role="status">
            <AlertTriangle size={16} />
            {t('watch.interrupted')}
          </div>
        )}
        <div className="watch-config">
          <section className="watch-panel">
            <h3>{t('watch.configuration')}</h3>
            <Field label={t('watch.workflow')}>
              <Select
                value={samples.some((sample) => sample.id === workflow?.id) ? workflow!.id : ''}
                onChange={(id) => {
                  const sample = samples.find((item) => item.id === id);
                  if (sample) {
                    setWorkflow(sample.workflow);
                    setValidation(null);
                  }
                }}
                options={options}
              />
            </Field>
            {workflow && <p className="watch-workflow-name">{workflow.name}</p>}
            <Button variant="secondary" onClick={() => void openWorkflow()}>
              {t('watch.loadWorkflow')}
            </Button>
            <Field label={t('watch.source')}>
              <div className="watch-path">
                <TextInput
                  value={sourceFolder}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="/path/to/inbox"
                />
                <Button
                  variant="secondary"
                  icon={<FolderOpen size={14} />}
                  onClick={() => void chooseFolder(setSource)}
                  aria-label={t('watch.pickSource')}
                />
              </div>
            </Field>
            <Field label={t('watch.output')}>
              <div className="watch-path">
                <TextInput
                  value={outputFolder}
                  onChange={(e) => setOutput(e.target.value)}
                  placeholder="/path/to/output"
                />
                <Button
                  variant="secondary"
                  icon={<FolderOpen size={14} />}
                  onClick={() => void chooseFolder(setOutput)}
                  aria-label={t('watch.pickOutput')}
                />
              </div>
            </Field>
            <div className="watch-numbers">
              <Field label={t('watch.pollSeconds')}>
                <TextInput
                  type="number"
                  min={1}
                  max={3600}
                  value={pollSeconds}
                  onChange={(e) => setPoll(Number(e.target.value))}
                />
              </Field>
              <Field label={t('watch.settleSeconds')}>
                <TextInput
                  type="number"
                  min={0}
                  max={3600}
                  value={settleSeconds}
                  onChange={(e) => setSettle(Number(e.target.value))}
                />
              </Field>
            </div>
            <Field label={t('watch.pattern')}>
              <TextInput value={pattern} onChange={(e) => setPattern(e.target.value)} />
            </Field>
            {validation && (
              <div
                className={`watch-validation ${validation.valid ? 'is-valid' : 'is-invalid'}`}
                role="status"
              >
                <strong>{validation.valid ? t('watch.valid') : t('watch.invalid')}</strong>
                {validation.errors.map((issue, index) => (
                  <p key={index}>{issue.message}</p>
                ))}
                {requiredVars.map((key) => (
                  <Field key={key} label={`{{${key}}}`}>
                    <TextInput
                      value={variables[key] ?? ''}
                      onChange={(e) => setVariables({ ...variables, [key]: e.target.value })}
                    />
                  </Field>
                ))}
                {requiredSecrets.map((key) => (
                  <Field key={key} label={key}>
                    <TextInput
                      type="password"
                      autoComplete="new-password"
                      value={secrets[key] ?? ''}
                      onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
                    />
                  </Field>
                ))}
              </div>
            )}
            <div className="watch-actions">
              <Button
                variant="secondary"
                onClick={() => void validate()}
                disabled={!workflow || busy || active}
              >
                {t('watch.validate')}
              </Button>
              {active ? (
                <Button variant="secondary" icon={<Square size={14} />} onClick={store.stop}>
                  {t('watch.stop')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<Play size={14} />}
                  disabled={!config || !validWatchConfig(config) || busy || !workflow}
                  onClick={() => void start()}
                >
                  {t('watch.start')}
                </Button>
              )}
            </div>
          </section>
          <section className="watch-panel watch-status" aria-live="polite">
            <h3>{t('watch.status')}</h3>
            <p>
              <strong>{t(`watch.${store.status}`)}</strong>
            </p>
            <div className="watch-counts">
              <span>{t('watch.pending', { count: store.pending })}</span>
              <span>{t('watch.queued', { count: store.queued })}</span>
            </div>
            {store.currentFile && (
              <p className="watch-current" title={store.currentFile}>
                {t('watch.current')}: {store.currentFile}
              </p>
            )}
            {store.error && (
              <p className="watch-error" role="alert">
                {store.error}
              </p>
            )}
            {!store.recent.length ? (
              <p className="watch-empty">{t('watch.emptyResults')}</p>
            ) : (
              <ul className="watch-results">
                {store.recent.map((row) => (
                  <li key={`${row.path}-${row.completedAt}`}>
                    <span className={`watch-result-status watch-result-status--${row.status}`}>
                      {t(`watch.${row.status}`)}
                    </span>
                    <span className="watch-result-path" title={row.path}>
                      {row.path.split(/[\\/]/).at(-1)}
                    </span>
                    {row.outputPath && (
                      <span className="watch-result-path" title={row.outputPath}>
                        {row.outputPath.split(/[\\/]/).at(-1)}
                      </span>
                    )}
                    {row.message && <small>{row.message}</small>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <p className="watch-footnote">{t('watch.appCloseNotice')}</p>
      </div>
    </Dialog>
  );
}
