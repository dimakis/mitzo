// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Capacitor } from '@capacitor/core';
import { WorkOutputs } from '../WorkOutputs';
import { apiFetch } from '../../lib/api-fetch';
import { downloadFile, shareTelosArtifact } from '../../lib/share-file';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/share-file', () => ({
  downloadFile: vi.fn().mockResolvedValue(true),
  shareTelosArtifact: vi.fn().mockResolvedValue(true),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
const notes = {
  id: 'a'.repeat(32),
  itemId: 'work',
  filename: 'notes.md',
  title: 'Research notes',
  revision: 2,
  size: 120,
  sha256: 'b'.repeat(64),
  url: '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=2',
};
const bundle = {
  ...notes,
  id: 'c'.repeat(32),
  filename: 'bundle.zip',
  title: 'Bundle',
  revision: 1,
  url: '/api/telos/artifacts/' + 'c'.repeat(32) + '?revision=1',
};
const response = (artifacts = [notes, bundle]) =>
  ({ ok: true, json: async () => ({ artifacts, limit: 100 }) }) as Response;
beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue(response());
});
describe('WorkOutputs', () => {
  it('shows saved Markdown and archive outputs with revision information', async () => {
    render(<WorkOutputs itemId="work" />);
    expect(screen.getByRole('heading', { name: 'Outputs' })).toBeTruthy();
    await screen.findByText('notes.md');
    expect(screen.getByText('bundle.zip')).toBeTruthy();
    expect(screen.getByText(/Revision 2/)).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/telos/items/work/artifacts',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('downloads and shares the exact listed revision', async () => {
    render(<WorkOutputs itemId="work" />);
    await screen.findByText('notes.md');
    fireEvent.click(screen.getByRole('button', { name: 'Download Research notes' }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith(notes.url));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Share Bundle' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Share Bundle' }));
    await waitFor(() => expect(shareTelosArtifact).toHaveBeenCalledWith(bundle.url));
  });
  it('explains an empty output list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(response([]));
    render(<WorkOutputs itemId="work" />);
    await screen.findByText('No saved outputs yet.');
  });
  it('offers retry on failure without claiming there are no outputs', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    render(<WorkOutputs itemId="work" />);
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByText('No saved outputs yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('notes.md');
  });
  it('keeps outputs visible when sharing fails', async () => {
    vi.mocked(shareTelosArtifact).mockRejectedValueOnce(new Error('Cannot share this file'));
    render(<WorkOutputs itemId="work" />);
    await screen.findByText('notes.md');
    fireEvent.click(screen.getByRole('button', { name: 'Share Research notes' }));
    await screen.findByText('Cannot share this file');
    expect(screen.getByText('bundle.zip')).toBeTruthy();
  });
  it('ignores late results belonging to previous work', async () => {
    let resolveOld!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = render(<WorkOutputs itemId="old" />);
    view.rerender(<WorkOutputs itemId="new" />);
    await screen.findByText('notes.md');
    await act(async () => {
      resolveOld(response([{ ...notes, title: 'Old output' }]));
    });
    await waitFor(() => expect(screen.queryByText('Old output')).toBeNull());
    expect(screen.getByText('notes.md')).toBeTruthy();
  });
});

it('uses Share on native clients without offering an unsupported browser download', async () => {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  render(<WorkOutputs itemId="work" />);
  await screen.findByText('notes.md');
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Share Research notes' })).toBeTruthy();
});
it('reports HTTP failures as unavailable instead of an empty list', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  render(<WorkOutputs itemId="work" />);
  await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByText('No saved outputs yet.')).toBeNull();
});
