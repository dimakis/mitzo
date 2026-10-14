// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/share-file', () => ({
  shareFile: vi.fn(),
  downloadFile: vi.fn(),
}));

import { shareFile, downloadFile } from '../../lib/share-file';
import { ShareButton } from '../ShareButton';
import { installDialogStub } from './dialog-stub';
beforeEach(installDialogStub);

const mockShareFile = vi.mocked(shareFile);

describe('ShareButton', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps actions behind one compact control', async () => {
    render(<ShareButton filePath="/workspace/file.md" />);
    expect(screen.queryByRole('button', { name: 'Share file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download file' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'File options' }));
    expect(screen.getByRole('button', { name: 'Share file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
  });

  it('retains Open and restores focus after dismissal', async () => {
    const open = vi.fn();
    render(<ShareButton filePath="report.md" onOpen={open} />);
    const trigger = screen.getByRole('button', { name: 'File options' });
    await userEvent.click(trigger);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores the actual file control after a touch click leaves another control focused', () => {
    render(
      <>
        <input aria-label="Composer" />
        <ShareButton filePath="report.pdf" />
      </>,
    );
    screen.getByRole('textbox', { name: 'Composer' }).focus();
    const trigger = screen.getByRole('button', { name: 'File options' });
    // Touch click events need not focus their target before the dialog opens.
    fireEvent.click(trigger);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps a pending action fenced when its options are closed and reopened', async () => {
    let complete!: (value: boolean) => void;
    mockShareFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    render(<ShareButton filePath="report.md" />);
    await userEvent.click(screen.getByRole('button', { name: 'File options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Share file' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.click(screen.getByRole('button', { name: 'File options' }));
    expect((screen.getByRole('button', { name: 'Sharing...' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Download file' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => complete(false));
    expect(screen.getByRole('button', { name: 'Share file' })).toBeTruthy();
  });

  it('offers a separate browser download action', async () => {
    vi.mocked(downloadFile).mockResolvedValue(true);
    render(<ShareButton filePath="report.md" sessionId="session-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Download file' }));
    expect(downloadFile).toHaveBeenCalledWith('report.md', 'session-1');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'File options' })
        .querySelector('svg')
        ?.getAttribute('data-icon'),
    ).toBe('check');
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    expect(screen.getByRole('button', { name: 'Downloaded' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share file' })).toBeTruthy();
  });

  it('shows done state after successful share', async () => {
    mockShareFile.mockResolvedValue(true);
    render(<ShareButton filePath="/workspace/file.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    expect(mockShareFile).toHaveBeenCalledWith('/workspace/file.md');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'File options' })
        .querySelector('svg')
        ?.getAttribute('data-icon'),
    ).toBe('check');
  });

  it('shows error state when share fails', async () => {
    mockShareFile.mockRejectedValue(new Error('Network error'));
    render(<ShareButton filePath="/workspace/file.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    expect(screen.getByRole('button', { name: 'Failed' })).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Failed' })
        .querySelector('svg')
        ?.getAttribute('data-icon'),
    ).toBe('error');
  });

  it('is disabled while busy', async () => {
    let resolveShare: (v: boolean) => void;
    mockShareFile.mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveShare = r;
        }),
    );
    render(<ShareButton filePath="/workspace/file.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    const busyBtn = screen.getByRole('button', { name: 'Sharing...' });
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveShare!(true);
    });
  });

  it('keeps cancellation neutral and forwards the originating session', async () => {
    mockShareFile.mockResolvedValue(false);
    render(<ShareButton filePath="report.md" sessionId="historical-session" />);
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Share file' }));
    expect(mockShareFile).toHaveBeenCalledWith('report.md', 'historical-session');
    expect(screen.getByRole('button', { name: 'Share file' })).toBeTruthy();
  });

  it.each(['resolve', 'reject'])(
    'allows a new file share and ignores stale %s completion',
    async (completion) => {
      const pending: { resolve: (value: boolean) => void; reject: (reason: Error) => void }[] = [];
      mockShareFile.mockImplementation(
        () => new Promise<boolean>((resolve, reject) => pending.push({ resolve, reject })),
      );
      const { rerender } = render(<ShareButton filePath="old.md" sessionId="old-session" />);
      fireEvent.click(screen.getByRole('button', { name: 'File options' }));
      await userEvent.click(screen.getByRole('button', { name: 'Share file' }));
      rerender(<ShareButton filePath="new.md" sessionId="new-session" />);
      fireEvent.click(screen.getByRole('button', { name: 'File options' }));
      await userEvent.click(screen.getByRole('button', { name: 'Share file' }));
      expect(mockShareFile).toHaveBeenLastCalledWith('new.md', 'new-session');
      await act(async () => {
        if (completion === 'resolve') pending[0].resolve(true);
        else pending[0].reject(new Error('Old error'));
      });
      expect(
        (screen.getByRole('button', { name: 'Sharing...' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => pending[1].resolve(false));
      expect(screen.getByRole('button', { name: 'Share file' })).toBeTruthy();
    },
  );

  it('does not schedule feedback after unmounting a pending share', async () => {
    let resolveShare!: (value: boolean) => void;
    mockShareFile.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveShare = resolve;
        }),
    );
    const { unmount } = render(<ShareButton filePath="old.md" />);
    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    await userEvent.click(screen.getByRole('button', { name: 'Share file' }));
    unmount();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    await act(async () => resolveShare(true));
    expect(timeout).not.toHaveBeenCalled();
  });

  it('stops event propagation on click', async () => {
    mockShareFile.mockResolvedValue(true);
    const parentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <ShareButton filePath="/workspace/file.md" />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'File options' }));
    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    expect(parentClick).not.toHaveBeenCalled();
  });
});
