import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureDialog } from './CaptureDialog';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
  close: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../app/state/ui', () => ({
  useUi: Object.assign(
    (selector: (state: { closeDialog: () => void; dialogData: undefined }) => unknown) =>
      selector({ closeDialog: mocks.close, dialogData: undefined }),
    { getState: () => ({ openDialog: vi.fn() }) },
  ),
}));
vi.mock('../../app/state/documents', () => ({ useDocs: { getState: () => ({ docs: [] }) } }));
vi.mock('../../app/actions', () => ({
  announceOutputs: vi.fn(),
  openFiles: vi.fn(),
  pickSavePath: vi.fn(),
  runDocOp: vi.fn(),
  saveDoc: vi.fn(),
  showError: vi.fn(),
}));
vi.mock('../../lib/bridge', () => ({
  chef: () => ({
    capture: { start: mocks.start, stop: mocks.stop },
    onEvent: mocks.onEvent,
    files: { toUrl: (path: string) => path },
  }),
}));
vi.mock('../../lib/rpc', () => ({ runOp: vi.fn() }));
vi.mock('../../components/Dialog', () => ({
  Dialog: ({
    onOpenChange,
    children,
    footer,
  }: {
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => (
    <div>
      <button onClick={() => onOpenChange(false)}>dismiss</button>
      {children}
      {footer}
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('CaptureDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stop.mockResolvedValue(undefined);
  });

  it('stops a session whose start completes after the dialog was closed', async () => {
    const pendingStart = deferred<{
      sessionId: string;
      url: string;
      qrSvg: string;
      expiresAt: number;
      interfaces: [];
    }>();
    mocks.start.mockReturnValue(pendingStart.promise);
    const view = render(<CaptureDialog />);

    fireEvent.click(view.container.querySelector('.capture__start')!);
    expect(mocks.start).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    view.unmount();

    pendingStart.resolve({
      sessionId: 'old-session',
      url: 'http://192.168.1.2:1234/c/' + 'a'.repeat(32),
      qrSvg: '<svg></svg>',
      expiresAt: Date.now() + 60_000,
      interfaces: [],
    });
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith('old-session'));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('uses the old session id when a late start resolves after a newer dialog starts', async () => {
    const oldStart = deferred<{
      sessionId: string;
      url: string;
      qrSvg: string;
      expiresAt: number;
      interfaces: [];
    }>();
    mocks.start.mockReturnValueOnce(oldStart.promise).mockResolvedValueOnce({
      sessionId: 'new-session',
      url: 'http://192.168.1.3:1234/c/' + 'b'.repeat(32),
      qrSvg: '<svg></svg>',
      expiresAt: Date.now() + 60_000,
      interfaces: [],
    });
    const oldDialog = render(<CaptureDialog />);
    fireEvent.click(oldDialog.container.querySelector('.capture__start')!);
    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    oldDialog.unmount();

    const newDialog = render(<CaptureDialog />);
    fireEvent.click(newDialog.container.querySelector('.capture__start')!);
    expect(await newDialog.findByText('capture.sameWifi')).toBeTruthy();

    oldStart.resolve({
      sessionId: 'old-session',
      url: 'http://192.168.1.2:1234/c/' + 'a'.repeat(32),
      qrSvg: '<svg></svg>',
      expiresAt: Date.now() + 60_000,
      interfaces: [],
    });
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith('old-session'));
    expect(mocks.stop).not.toHaveBeenCalledWith('new-session');
    expect(newDialog.container.querySelector('.capture__url code')?.textContent).toContain(
      '192.168.1.3',
    );
  });
});
