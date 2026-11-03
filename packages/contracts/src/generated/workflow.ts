/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: pydantic workflow models and result contracts (core/chef_core/workflow).
 * Regenerate: cd core && uv run python -m chef_core.codegen
 */

export interface Workflow {
  id: string;
  /** Name (Vietnamese). */
  name: string;
  /** @default "" */
  description?: string;
  /** @default 1 */
  version?: number;
  steps: WorkflowStep[];
  inputs?: WorkflowInputs;
  output?: WorkflowOutput;
  /** Defaults for {{name}} placeholders. */
  variables?: Record<string, string>;
}

export interface WorkflowStep {
  /** Operation id, e.g. page.rotate. */
  op: string;
  /** Params of that operation (placeholders allowed). */
  params?: Record<string, unknown>;
  /** Name shown in the UI. */
  label?: string | null;
  /**
   * A disabled step is kept but not run.
   * @default true
   */
  enabled?: boolean;
  /**
   * stop: the file fails here. skip: go on with the next step.
   * @default "stop"
   */
  onError?: 'stop' | 'skip';
}

export interface WorkflowInputs {
  /**
   * each: run once per PDF; merge: combine all selected PDFs and run once.
   * @default "each"
   */
  mode?: 'each' | 'merge';
  /** @default ["pdf"] */
  accept?: ('pdf' | 'images')[];
  /**
   * Ask for a password of an encrypted input file.
   * @default false
   */
  password?: boolean;
}

export interface WorkflowOutput {
  /**
   * suffix: next to the input. folder: into a folder.
   * @default "suffix"
   */
  mode?: 'suffix' | 'folder' | 'overwrite';
  /** @default "_da-xu-ly" */
  suffix?: string;
  folder?: string | null;
  /** Name template, e.g. {name}_{date}_da-ky. */
  nameTemplate?: string | null;
  /**
   * Lưu thêm PDF đã xử lý khi quy trình có bước xuất tài liệu.
   * @default false
   */
  alsoSavePdf?: boolean;
  /** Giới hạn dung lượng PDF cuối cùng; file vượt giới hạn sẽ được báo lỗi. */
  maxBytes?: number | null;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  steps: WorkflowStepSummary[];
  requiredSecrets: string[];
  requiredVariables: string[];
  workflowId: string;
  descriptions: string[];
}

export interface WorkflowRunResult {
  results: WorkflowFileResult[];
  summary: WorkflowRunSummary;
  dryRun: boolean;
}

export interface WorkflowSamplesResult {
  samples: WorkflowSample[];
}

export interface WorkflowFileResult {
  path: string;
  outputPath: string | null;
  outputs: string[];
  plannedOutputs: string[];
  plannedOutputPath?: string | null;
  status: 'done' | 'failed' | 'skipped';
  failedStep: number | null;
  errorKind: string | null;
  message: string | null;
  warnings: string[];
  stepResults: WorkflowStepResult[];
  durationMs: number;
}

export interface WorkflowIssue {
  kind: string;
  message: string;
  step: number | null;
  field: string | null;
}

export interface WorkflowRunSummary {
  total: number;
  done: number;
  failed: number;
  skipped: number;
}

export interface WorkflowSample {
  id: string;
  name: string;
  description: string;
  workflow: Workflow;
}

export interface WorkflowStepResult {
  index: number;
  op: string;
  label: string;
  changedPages: number[] | 'all';
  warnings: string[];
}

export interface WorkflowStepSummary {
  index: number;
  op: string;
  title: string;
  label: string;
  enabled: boolean;
  description: string;
  destructive: boolean;
  finalizing: boolean;
  standalone: boolean;
  needsSecrets: string[];
  batchIncompatible: boolean;
}
