// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../lib/share-file', () => ({
  shareFile: vi.fn(),
}));

import { shareFile } from '../../lib/share-file';
import { ShareButton } from '../ShareButton';

const mockShareFile = vi.mocked(shareFile);

describe('ShareButton', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders with share label by default', () => {
    render(<ShareButton filePath="/workspace/file.md" />);
    const btn = screen.getByRole('button', { name: 'Share file' });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('\u21A6');
  });

  it('shows done state after successful share', async () => {
    mockShareFile.mockResolvedValue(true);
    render(<ShareButton filePath="/workspace/file.md" />);

    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    expect(mockShareFile).toHaveBeenCalledWith('/workspace/file.md');
    expect(screen.getByRole('button', { name: 'Shared' })).toBeTruthy();
  });

  it('shows error state when share fails', async () => {
    mockShareFile.mockRejectedValue(new Error('Network error'));
    render(<ShareButton filePath="/workspace/file.md" />);

    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    expect(screen.getByRole('button', { name: 'Failed' })).toBeTruthy();
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
      await userEvent.click(screen.getByRole('button', { name: 'Share file' }));
      rerender(<ShareButton filePath="new.md" sessionId="new-session" />);
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

    const btn = screen.getByRole('button', { name: 'Share file' });
    await act(async () => {
      await userEvent.click(btn);
    });

    expect(parentClick).not.toHaveBeenCalled();
  });
});
