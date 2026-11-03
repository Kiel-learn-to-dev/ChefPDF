import type { OpParams, Workflow, WorkflowStep } from '@chef/contracts';

export function createWorkflow(initialStep?: WorkflowStep): Workflow {
  return {
    id: `workflow-${Date.now().toString(36)}`,
    name: 'Quy trình mới',
    version: 1,
    steps: initialStep ? [{ ...initialStep, params: { ...initialStep.params } }] : [],
    inputs: { accept: ['pdf'] },
    output: { mode: 'suffix', suffix: '_da-xu-ly' },
  };
}

export function buildWorkflowOutputOverride(
  output: Workflow['output'],
  selection: {
    mode: 'suffix' | 'folder' | 'overwrite';
    suffix: string;
    folder: string;
    nameTemplate: string;
  },
): NonNullable<NonNullable<OpParams['workflow.run']['output']>> {
  return {
    mode: selection.mode,
    suffix: selection.suffix,
    ...(selection.mode === 'folder' && selection.folder ? { folder: selection.folder } : {}),
    ...(selection.nameTemplate ? { nameTemplate: selection.nameTemplate } : {}),
    ...(output?.alsoSavePdf ? { alsoSavePdf: true } : {}),
    ...(output?.maxBytes != null ? { maxBytes: output.maxBytes } : {}),
  };
}

export function moveWorkflowStep<T>(steps: T[], index: number, delta: -1 | 1): T[] {
  const next = [...steps];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function removeWorkflowStep<T>(steps: T[], index: number): T[] {
  return steps.filter((_, itemIndex) => itemIndex !== index);
}

export function parseWorkflowJson(text: string): Workflow {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workflow JSON must be an object.');
  }
  return value as Workflow;
}

export function formatWorkflowJson(workflow: Workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}
