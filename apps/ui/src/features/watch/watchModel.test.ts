import { describe, expect, it } from 'vitest';
import {
  watchDelayMs,
  watchLedgerPath,
  watchScanParams,
  validWatchConfig,
  workflowOutput,
  type WatchConfig,
} from './watchModel';
import type { Workflow } from '@chef/contracts';

const workflow = {
  id: 'scan/export',
  name: 'Scan and export',
  steps: [],
  output: { mode: 'suffix', alsoSavePdf: true },
} as unknown as Workflow;
const config: WatchConfig = {
  sourceFolder: '/in',
  outputFolder: '/out',
  workflow,
  pollSeconds: 5,
  settleSeconds: 2,
  pattern: '*.pdf',
};

describe('watch model', () => {
  it('places the ledger inside the output folder and sanitizes workflow ids', () => {
    expect(watchLedgerPath('/out/', workflow.id, 'posix')).toBe(
      '/out/.chef-watch-scan_export.json',
    );
    expect(watchLedgerPath('C:\\', 'ra-word', 'win32')).toBe('C:\\.chef-watch-ra-word.json');
  });

  it('uses source scan configuration and forces watched outputs into the chosen folder', () => {
    expect(watchScanParams(config, '/out/.ledger')).toEqual({
      directory: '/in',
      outputDirectory: '/out',
      ledgerPath: '/out/.ledger',
      settleSeconds: 2,
      pattern: '*.pdf',
    });
    expect(workflowOutput(config)).toEqual({ mode: 'folder', folder: '/out', alsoSavePdf: true });
  });

  it('validates ranges and bounds scan delays', () => {
    expect(validWatchConfig(config)).toBe(true);
    expect(validWatchConfig({ ...config, outputFolder: '/in/' })).toBe(false);
    expect(
      validWatchConfig({ ...config, sourceFolder: '/tmp/inbox/../in', outputFolder: '/tmp/in' }),
    ).toBe(false);
    expect(validWatchConfig({ ...config, pollSeconds: 0 })).toBe(false);
    expect(validWatchConfig({ ...config, settleSeconds: 3601 })).toBe(false);
    expect(watchDelayMs(0)).toBe(1000);
    expect(watchDelayMs(9999)).toBe(3600000);
  });
});
