import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../../i18n';
import { DewarpDialog } from './DewarpDialog';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  runOp: vi.fn(),
  runDocOp: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../../app/state/documents', () => ({
  useActiveDoc: () => ({
    id: 'session-1',
    name: 'book.pdf',
    info: { pageCount: 5 },
    state: { signed: false },
  }),
}));

vi.mock('../../app/state/ui', () => ({
  useUi: (selector: (state: { closeDialog: () => void }) => unknown) =>
    selector({ closeDialog: mocks.close }),
}));

vi.mock('../../app/actions', () => ({
  runDocOp: mocks.runDocOp,
  showError: vi.fn(),
}));

vi.mock('../../lib/rpc', () => ({
  runOp: mocks.runOp,
  cancelJob: vi.fn(),
}));

vi.mock('../../lib/bridge', () => ({
  chef: () => ({ files: { toUrl: (path: string) => path } }),
}));

vi.mock('../jobs/jobStore', () => ({
  useJobStore: (selector: (state: { jobs: never[] }) => unknown) => selector({ jobs: [] }),
  jobProgress: () => null,
}));

vi.mock('../../components/Toast', () => ({ toast: { warning: mocks.warning } }));

function renderDialog() {
  return render(
    <I18nextProvider i18n={i18n}>
      <DewarpDialog />
    </I18nextProvider>,
  );
}

describe('DewarpDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOp.mockResolvedValue({
      data: {
        pages: [
          {
            pageIndex: 0,
            status: 'done',
            originalPath: '/preview/original.png',
            resultPath: '/preview/result.png',
            confidence: 0.82,
            correctionPx: 14,
          },
        ],
      },
    });
    mocks.runDocOp.mockResolvedValue({
      data: { pages: [{ pageIndex: 0, status: 'done' }] },
      warnings: [],
    });
  });

  it('requires a current before/after preview before applying', async () => {
    renderDialog();
    const apply = screen.getByRole('button', { name: 'Áp dụng làm phẳng' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));
    expect(await screen.findByText('Độ tin cậy: 82%')).toBeTruthy();
    expect((screen.getByAltText('Ảnh gốc') as HTMLImageElement).src).toContain(
      '/preview/original.png',
    );
    expect((screen.getByAltText('Sau khi làm phẳng') as HTMLImageElement).src).toContain(
      '/preview/result.png',
    );
    expect((apply as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(apply);
    await waitFor(() =>
      expect(mocks.runDocOp).toHaveBeenCalledWith(
        'session-1',
        'pageimg.dewarp',
        { minConfidence: 0.35 },
        'Làm phẳng trang cong — book.pdf',
        expect.any(Object),
      ),
    );
    expect(mocks.close).toHaveBeenCalled();
  });

  it('shows low-confidence preview warning before allowing the user to continue', async () => {
    mocks.runOp.mockResolvedValueOnce({
      data: {
        pages: [
          {
            pageIndex: 2,
            status: 'done',
            originalPath: '/preview/original.png',
            resultPath: '/preview/result.png',
            confidence: 0.1,
            correctionPx: 2,
          },
        ],
      },
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Xem trước' }));

    expect(await screen.findByText(/3 cần xem lại/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Áp dụng làm phẳng' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
