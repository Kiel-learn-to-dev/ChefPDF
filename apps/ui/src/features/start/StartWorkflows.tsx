import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Workflow as WorkflowIcon } from 'lucide-react';
import type {
  WorkflowRunResult,
  WorkflowSample,
  WorkflowSamplesResult,
  WorkflowValidationResult,
} from '@chef/contracts';
import { useUi } from '../../app/state/ui';
import { showError } from '../../app/actions';
import { toast } from '../../components/Toast';
import { pathsForDroppedFiles } from '../../lib/bridge';
import { runOp } from '../../lib/rpc';
import { needsMoreWorkflowFiles, needsWorkflowReview } from './startWorkflowModel';

/** Available bundled workflows. Dropping PDFs starts safe workflows, or opens their setup. */
export function StartWorkflows() {
  const { t } = useTranslation();
  const [samples, setSamples] = useState<WorkflowSample[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const dropInProgress = useRef(false);
  useEffect(() => {
    let alive = true;
    void runOp('workflow.samples', {}, { title: t('workflow.sample'), silent: true })
      .then((result) => {
        const items = (result.data as WorkflowSamplesResult | undefined)?.samples;
        if (alive && Array.isArray(items)) setSamples(items);
      })
      .catch((error: unknown) => {
        if (alive) showError(error, t('workflow.samplesFailed'));
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const open = (sample: WorkflowSample, files: string[] = [], result?: WorkflowRunResult) =>
    useUi.getState().openDialog('workflow', { sample, files, result });

  const drop = async (event: DragEvent, sample: WorkflowSample) => {
    event.preventDefault();
    if (dropInProgress.current) return;
    dropInProgress.current = true;
    const all = [...event.dataTransfer.files];
    const files = all.filter(
      (file) => file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf',
    );
    if (files.length !== all.length) toast.info(t('drop.onlyPdf'));
    setRunning(sample.id);
    let paths: string[] = [];
    try {
      paths = await pathsForDroppedFiles(files);
      if (paths.length !== files.length || !paths.length) {
        toast.error(t('drop.unsupported'));
        return;
      }
      if (needsMoreWorkflowFiles(sample.workflow, paths.length)) {
        open(sample, paths);
        return;
      }
      const validation = await runOp(
        'workflow.validate',
        {
          workflow: sample.workflow as unknown as Record<string, unknown>,
          variables: sample.workflow.variables ?? {},
        },
        { title: t('workflow.validate'), silent: true },
      );
      const report = validation.data as WorkflowValidationResult;
      if (needsWorkflowReview(sample.workflow, report)) {
        open(sample, paths);
        return;
      }
      const result = await runOp(
        'workflow.run',
        {
          workflow: sample.workflow as unknown as Record<string, unknown>,
          files: paths.map((path) => ({ path })),
          variables: sample.workflow.variables ?? {},
        },
        { title: sample.name },
      );
      const data = result.data as WorkflowRunResult;
      const summary = t('start.workflowSummary', { ...data.summary });
      const actions = [
        { label: t('start.workflowResults'), onClick: () => open(sample, paths, data) },
      ];
      if (
        data.summary.failed ||
        data.summary.skipped ||
        data.results.some((row) => row.warnings.length)
      )
        toast.warning(sample.name, summary, actions);
      else toast.success(sample.name, summary, actions);
    } catch (error) {
      showError(error, t('workflow.runFailed'));
      if (paths.length) open(sample, paths);
    } finally {
      dropInProgress.current = false;
      setRunning(null);
    }
  };

  if (!samples.length) return null;
  return (
    <section aria-labelledby="start-workflows">
      <h2 id="start-workflows" className="start__section-title">
        {t('start.workflows')}
      </h2>
      <p className="start__workflow-hint">{t('start.workflowHint')}</p>
      <ul className="start__tiles">
        {samples.map((sample) => (
          <li key={sample.id}>
            <button
              type="button"
              className="tile tile--violet"
              disabled={running !== null}
              onClick={() => open(sample)}
              onDragOver={(event) => {
                if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
              }}
              onDrop={(event) => void drop(event, sample)}
            >
              <span className="tile__icon">
                <WorkflowIcon size={22} />
              </span>
              <span className="tile__title">{sample.name}</span>
              <span className="tile__text">{sample.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
