import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DropZone } from './DropZone';
const mocks = vi.hoisted(() => ({ open: vi.fn(), paths: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../lib/bridge', () => ({ pathsForDroppedFiles: mocks.paths }));
vi.mock('./actions', () => ({ openFiles: mocks.open }));
vi.mock('../components/Toast', () => ({ toast: { info: mocks.info, error: mocks.error } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paths.mockResolvedValue(['C:/file.pdf']);
});
afterEach(cleanup);
const transfer = {
  types: ['Files'],
  files: [new File(['pdf'], 'file.pdf', { type: 'application/pdf' })],
};

it('opens a normal dropped PDF', async () => {
  render(<DropZone />);
  fireEvent.drop(window, { dataTransfer: transfer });
  await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(['C:/file.pdf']));
});

it('does not open a file when a workflow tile already handled the drop', () => {
  const view = render(
    <>
      <button onDrop={(event) => event.preventDefault()}>target</button>
      <DropZone />
    </>,
  );
  fireEvent.drop(view.getByRole('button', { name: 'target' }), { dataTransfer: transfer });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.paths).not.toHaveBeenCalled();
});
