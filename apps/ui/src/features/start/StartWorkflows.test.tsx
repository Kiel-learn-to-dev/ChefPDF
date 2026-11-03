import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartWorkflows } from './StartWorkflows';

const mocks = vi.hoisted(() => ({
  runOp: vi.fn(),
  paths: vi.fn(),
  open: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../lib/rpc', () => ({ runOp: mocks.runOp }));
vi.mock('../../lib/bridge', () => ({ pathsForDroppedFiles: mocks.paths }));
vi.mock('../../app/state/ui', () => ({ useUi: { getState: () => ({ openDialog: mocks.open }) } }));
vi.mock('../../app/actions', () => ({ showError: mocks.error }));
vi.mock('../../components/Toast', () => ({
  toast: { info: vi.fn(), error: mocks.error, success: mocks.success, warning: mocks.warning },
}));
const sample = {
  id: 'demo',
  name: 'Demo',
  description: 'Demo workflow',
  workflow: { id: 'demo', name: 'Demo', steps: [], output: { mode: 'suffix' } },
};
const valid = { valid: true, warnings: [], requiredSecrets: [], requiredVariables: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paths.mockResolvedValue(['C:/in.pdf']);
});
afterEach(cleanup);

it('runs a validated workflow for a dropped PDF and provides result details', async () => {
  mocks.runOp.mockImplementation(async (op: string) => {
    if (op === 'workflow.samples') return { data: { samples: [sample] } };
    if (op === 'workflow.validate') return { data: valid };
    return { data: { summary: { done: 1, failed: 0, skipped: 0 }, results: [{ warnings: [] }] } };
  });
  render(<StartWorkflows />);
  const button = await screen.findByRole('button', { name: /Demo/ });
  fireEvent.drop(button, {
    dataTransfer: {
      files: [new File(['pdf'], 'in.pdf', { type: 'application/pdf' })],
      types: ['Files'],
    },
  });
  await waitFor(() =>
    expect(mocks.runOp).toHaveBeenCalledWith(
      'workflow.run',
      expect.objectContaining({ files: [{ path: 'C:/in.pdf' }] }),
      expect.anything(),
    ),
  );
  await waitFor(() => expect(mocks.success).toHaveBeenCalled());
  expect(mocks.open).not.toHaveBeenCalled();
});

it('shows a warning toast when a successful step needs manual review', async () => {
  const cropSample = {
    ...sample,
    workflow: { ...sample.workflow, steps: [{ op: 'pageimg.autoCrop' }] },
  };
  mocks.runOp.mockImplementation(async (op: string) => {
    if (op === 'workflow.samples') return { data: { samples: [cropSample] } };
    if (op === 'workflow.validate') return { data: valid };
    return {
      data: {
        summary: { done: 1, failed: 0, skipped: 0 },
        results: [{ warnings: ['Bước pageimg.autoCrop: cần duyệt thủ công trang 1.'] }],
      },
    };
  });
  render(<StartWorkflows />);
  const button = await screen.findByRole('button', { name: /Demo/ });
  fireEvent.drop(button, {
    dataTransfer: { files: [new File(['pdf'], 'in.pdf')], types: ['Files'] },
  });
  await waitFor(() => expect(mocks.warning).toHaveBeenCalled());
  expect(mocks.success).not.toHaveBeenCalled();
});

it('opens setup with dropped files when a secret is required', async () => {
  mocks.runOp.mockImplementation(async (op: string) =>
    op === 'workflow.samples'
      ? { data: { samples: [sample] } }
      : { data: { ...valid, requiredSecrets: ['pin'] } },
  );
  render(<StartWorkflows />);
  const button = await screen.findByRole('button', { name: /Demo/ });
  fireEvent.drop(button, {
    dataTransfer: { files: [new File(['pdf'], 'in.pdf')], types: ['Files'] },
  });
  await waitFor(() =>
    expect(mocks.open).toHaveBeenCalledWith(
      'workflow',
      expect.objectContaining({ sample, files: ['C:/in.pdf'] }),
    ),
  );
  expect(mocks.runOp.mock.calls.some(([op]) => op === 'workflow.run')).toBe(false);
});

it('opens setup instead of running a merge workflow with only one dropped PDF', async () => {
  const mergeSample = {
    ...sample,
    workflow: { ...sample.workflow, inputs: { mode: 'merge', password: true } },
  };
  mocks.runOp.mockImplementation(async (op: string) =>
    op === 'workflow.samples' ? { data: { samples: [mergeSample] } } : { data: valid },
  );
  render(<StartWorkflows />);
  const button = await screen.findByRole('button', { name: /Demo/ });
  fireEvent.drop(button, {
    dataTransfer: { files: [new File(['pdf'], 'in.pdf')], types: ['Files'] },
  });
  await waitFor(() =>
    expect(mocks.open).toHaveBeenCalledWith(
      'workflow',
      expect.objectContaining({ sample: mergeSample, files: ['C:/in.pdf'] }),
    ),
  );
  expect(mocks.runOp.mock.calls.some(([op]) => op === 'workflow.run')).toBe(false);
});

it('runs a valid workflow with automatic crop without requiring extra setup', async () => {
  const cropSample = {
    ...sample,
    workflow: { ...sample.workflow, steps: [{ op: 'pageimg.autoCrop' }] },
  };
  mocks.runOp.mockImplementation(async (op: string) =>
    op === 'workflow.samples'
      ? { data: { samples: [cropSample] } }
      : op === 'workflow.validate'
        ? { data: valid }
        : { data: { summary: { done: 1, failed: 0, skipped: 0 }, results: [{ warnings: [] }] } },
  );
  render(<StartWorkflows />);
  const button = await screen.findByRole('button', { name: /Demo/ });
  fireEvent.drop(button, {
    dataTransfer: { files: [new File(['pdf'], 'in.pdf')], types: ['Files'] },
  });
  await waitFor(() =>
    expect(mocks.runOp).toHaveBeenCalledWith(
      'workflow.run',
      expect.objectContaining({ files: [{ path: 'C:/in.pdf' }] }),
      expect.anything(),
    ),
  );
  expect(mocks.open).not.toHaveBeenCalled();
});

it('ignores a second drop while resolving the first', async () => {
  let resolvePaths!: (paths: string[]) => void;
  mocks.paths.mockReturnValue(
    new Promise<string[]>((resolve) => {
      resolvePaths = resolve;
    }),
  );
  mocks.runOp.mockImplementation(async (op: string) =>
    op === 'workflow.samples'
      ? { data: { samples: [sample] } }
      : { data: { ...valid, requiredSecrets: ['pin'] } },
  );
  render(<StartWorkflows />);
  const button = await screen.findByRole('button', { name: /Demo/ });
  const dataTransfer = { files: [new File(['pdf'], 'in.pdf')], types: ['Files'] };
  fireEvent.drop(button, { dataTransfer });
  fireEvent.drop(button, { dataTransfer });
  expect(mocks.paths).toHaveBeenCalledTimes(1);
  resolvePaths(['C:/in.pdf']);
  await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
});
