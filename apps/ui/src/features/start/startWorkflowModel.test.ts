import { describe, expect, it } from 'vitest';
import {
  hasWorkflowDataRisk,
  needsMoreWorkflowFiles,
  needsWorkflowReview,
} from './startWorkflowModel';
import type { Workflow, WorkflowValidationResult } from '@chef/contracts';

const flow: Workflow = { id: 'x', name: 'X', steps: [], output: { mode: 'suffix' } };
const valid: WorkflowValidationResult = {
  valid: true,
  errors: [],
  warnings: [],
  steps: [],
  requiredSecrets: [],
  requiredVariables: [],
  workflowId: 'x',
  descriptions: [],
};

describe('starting a workflow from a dropped file', () => {
  it('requires two files when the workflow merges its inputs', () => {
    const mergeFlow: Workflow = { ...flow, inputs: { mode: 'merge' } };
    expect(needsMoreWorkflowFiles(mergeFlow, 1)).toBe(true);
    expect(needsMoreWorkflowFiles(mergeFlow, 2)).toBe(false);
    expect(needsMoreWorkflowFiles(flow, 1)).toBe(false);
  });
  it('runs only when validation passes and no further input or overwrite approval is needed', () => {
    expect(needsWorkflowReview(flow, valid)).toBe(false);
    expect(needsWorkflowReview({ ...flow, steps: [{ op: 'pageimg.autoCrop' }] }, valid)).toBe(
      false,
    );
    expect(needsWorkflowReview({ ...flow, steps: [{ op: 'pageimg.removeFingers' }] }, valid)).toBe(
      true,
    );
    expect(
      needsWorkflowReview(
        { ...flow, steps: [{ op: 'pageimg.removeFingers', enabled: false }] },
        valid,
      ),
    ).toBe(false);
    expect(needsWorkflowReview({ ...flow, steps: [{ op: 'export.document' }] }, valid)).toBe(false);
    expect(needsWorkflowReview(flow, { ...valid, valid: false })).toBe(true);
    expect(needsWorkflowReview(flow, { ...valid, requiredSecrets: ['pin'] })).toBe(true);
    expect(needsWorkflowReview(flow, { ...valid, requiredVariables: ['path'] })).toBe(true);
    expect(needsWorkflowReview({ ...flow, output: { mode: 'overwrite' } }, valid)).toBe(true);
    expect(needsWorkflowReview({ ...flow, inputs: { password: true } }, valid)).toBe(true);
    expect(
      needsWorkflowReview(flow, {
        ...valid,
        warnings: [{ kind: 'WARN', message: 'warning', step: null, field: null }],
      }),
    ).toBe(true);
  });
});

describe('workflow data risk warning', () => {
  it('flags enabled pixel and content transforms but ignores read-only or disabled steps', () => {
    expect(hasWorkflowDataRisk({ ...flow, steps: [{ op: 'pageimg.autoCrop' }] })).toBe(true);
    expect(hasWorkflowDataRisk({ ...flow, steps: [{ op: 'compress.pdf', enabled: false }] })).toBe(
      false,
    );
    expect(hasWorkflowDataRisk({ ...flow, steps: [{ op: 'compress.fitSize' }] })).toBe(false);
    expect(hasWorkflowDataRisk({ ...flow, steps: [{ op: 'pages.rotate' }] })).toBe(false);
  });
});
