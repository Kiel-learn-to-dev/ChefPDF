import type { Workflow, WorkflowValidationResult } from '@chef/contracts';

const WORKFLOW_DATA_RISK_OPS = new Set([
  'pageimg.autoCrop',
  'pageimg.crop',
  'pageimg.splitSpread',
  'pageimg.deskew',
  'pageimg.dewarp',
  'pageimg.removeFingers',
  'pageimg.enhance',
  'scan.rasterize',
  'compress.pdf',
  'overlay.pageNumbers',
  'stamp.seam',
  'sign.pades',
]);

/** Whether an enabled workflow step may crop/remove content, alter pixels, reduce quality, or sign. */
export function hasWorkflowDataRisk(flow: Workflow): boolean {
  return flow.steps.some((step) => step.enabled !== false && WORKFLOW_DATA_RISK_OPS.has(step.op));
}

export function needsMoreWorkflowFiles(flow: Workflow, fileCount: number): boolean {
  return flow.inputs?.mode === 'merge' && fileCount < 2;
}

/** A dropped workflow runs immediately unless validation/input or a step-specific review is needed. */
export function needsWorkflowReview(flow: Workflow, report: WorkflowValidationResult): boolean {
  return (
    // Finger removal must use the propose/edit/apply flow; automatic deletion can erase text.
    flow.steps.some((step) => step.enabled !== false && step.op === 'pageimg.removeFingers') ||
    !report.valid ||
    report.warnings.length > 0 ||
    report.requiredSecrets.length > 0 ||
    report.requiredVariables.some((key) => !flow.variables?.[key]?.trim()) ||
    flow.output?.mode === 'overwrite' ||
    flow.inputs?.password === true
  );
}
