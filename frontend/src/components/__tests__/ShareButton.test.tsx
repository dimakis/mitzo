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
      () => new Promise<boolean>((r) => { resolveShare = r; }),
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
