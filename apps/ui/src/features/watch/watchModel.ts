import type { Workflow } from '@chef/contracts';

export type WatchStatus = 'stopped' | 'running' | 'stopping' | 'error';
export type WatchFileStatus = 'done' | 'failed' | 'skipped';

export interface WatchConfig {
  sourceFolder: string;
  outputFolder: string;
  workflow: Workflow;
  pollSeconds: number;
  settleSeconds: number;
  pattern: string;
}

export interface WatchFileResult {
  path: string;
  status: WatchFileStatus;
  outputPath: string | null;
  message: string | null;
  completedAt: number;
}

export function watchLedgerPath(folder: string, workflowId: string, platform: string): string {
  const separator = platform === 'win32' ? '\\' : '/';
  let root = folder.replace(/[\\/]+$/, '');
  if (!root && /^[\\/]+$/.test(folder)) root = separator;
  const id = workflowId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'workflow';
  const leaf = `.chef-watch-${id}.json`;
  return root.endsWith(separator) ? `${root}${leaf}` : `${root}${separator}${leaf}`;
}

export function watchScanParams(config: WatchConfig, ledgerPath: string) {
  return {
    directory: config.sourceFolder,
    outputDirectory: config.outputFolder,
    ledgerPath,
    settleSeconds: config.settleSeconds,
    pattern: config.pattern,
  };
}

export function workflowOutput(config: WatchConfig) {
  return {
    mode: 'folder' as const,
    folder: config.outputFolder,
    alsoSavePdf: config.workflow.output?.alsoSavePdf ?? false,
  };
}

export function validWatchConfig(config: WatchConfig): boolean {
  const canonicalFolder = (path: string) => {
    const value = path.trim().replace(/\\/g, '/');
    const drive = /^[a-zA-Z]:/.exec(value)?.[0].toLocaleLowerCase() ?? '';
    const absolute =
      value.startsWith('/') || (!!drive && value.slice(drive.length).startsWith('/'));
    const stack: string[] = [];
    for (const part of value.slice(drive.length).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && stack.length && stack.at(-1) !== '..') stack.pop();
      else if (part !== '..' || !absolute) stack.push(part);
    }
    return (
      `${drive}${absolute && !drive ? '/' : ''}${stack.join('/')}`
        .replace(/\/$/, '')
        .toLocaleLowerCase() || '/'
    );
  };
  return (
    !!config.sourceFolder.trim() &&
    !!config.outputFolder.trim() &&
    canonicalFolder(config.sourceFolder) !== canonicalFolder(config.outputFolder) &&
    !!config.workflow.id &&
    !!config.pattern.trim() &&
    Number.isFinite(config.pollSeconds) &&
    config.pollSeconds >= 1 &&
    config.pollSeconds <= 3600 &&
    Number.isFinite(config.settleSeconds) &&
    config.settleSeconds >= 0 &&
    config.settleSeconds <= 3600
  );
}

export function watchDelayMs(seconds: number): number {
  return Math.max(1, Math.min(3600, Math.floor(seconds))) * 1000;
}
