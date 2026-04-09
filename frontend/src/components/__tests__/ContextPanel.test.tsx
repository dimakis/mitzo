// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ContextPanel } from '../ContextPanel';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockConfigResponse(contextBlocks: Record<string, { path: string; sizeBytes: number }>) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    json: () => Promise.resolve({ contextBlocks }),
  });
}

describe('ContextPanel', () => {
  it('fetches and renders context blocks', async () => {
    mockConfigResponse({
      'boot-context': { path: '/ctx/boot.md', sizeBytes: 2048 },
      constitution: { path: '/ctx/const.md', sizeBytes: 512 },
    });
    render(<ContextPanel selected={[]} onToggle={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('boot-context')).toBeTruthy();
      expect(screen.getByText('constitution')).toBeTruthy();
    });
  });

  it('shows selected state for active blocks', async () => {
    mockConfigResponse({
      'boot-context': { path: '/ctx/boot.md', sizeBytes: 2048 },
    });
    const { container } = render(<ContextPanel selected={['boot-context']} onToggle={vi.fn()} />);
    await waitFor(() => {
      expect(container.querySelector('.context-panel-item--selected')).toBeTruthy();
    });
  });

  it('calls onToggle when block clicked', async () => {
    mockConfigResponse({
      'boot-context': { path: '/ctx/boot.md', sizeBytes: 2048 },
    });
    const onToggle = vi.fn();
    render(<ContextPanel selected={[]} onToggle={onToggle} />);
    await waitFor(() => screen.getByText('boot-context'));
    fireEvent.click(screen.getByText('boot-context'));
    expect(onToggle).toHaveBeenCalledWith('boot-context');
  });

  it('shows file size', async () => {
    mockConfigResponse({
      'boot-context': { path: '/ctx/boot.md', sizeBytes: 2048 },
    });
    render(<ContextPanel selected={[]} onToggle={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('2.0 KB')).toBeTruthy();
    });
  });

  it('shows empty state when no blocks configured', async () => {
    mockConfigResponse({});
    render(<ContextPanel selected={[]} onToggle={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('No context blocks')).toBeTruthy();
    });
  });

  it('handles fetch error gracefully', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    render(<ContextPanel selected={[]} onToggle={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('No context blocks')).toBeTruthy();
    });
  });
});
