// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UserOutputUpload } from '../UserOutputUpload';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('uploads selected bytes with operator endpoint and preserves same filename for revision', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ artifact: { revision: 2 } }),
  } as Response);
  const uploaded = vi.fn();
  render(<UserOutputUpload itemId="lifeops" onUploaded={uploaded} />);
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File(['safe notes'], 'notes.md', { type: 'text/markdown' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Saved revision 2.');
  const [url, options] = vi.mocked(apiFetch).mock.calls[0];
  expect(url).toBe('/api/telos/items/lifeops/artifacts/upload');
  expect(JSON.parse(options!.body as string)).toMatchObject({
    filename: 'notes.md',
    title: 'notes.md',
    base64: btoa('safe notes'),
    requestId: expect.any(String),
  });
  expect(uploaded).toHaveBeenCalledTimes(1);
});
it('keeps selected evidence and request identity for retry after failure', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ artifact: { revision: 1 } }),
    } as Response);
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File(['notes'], 'notes.md')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Offline');
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Saved revision 1.');
  const inputs = vi
    .mocked(apiFetch)
    .mock.calls.map(([, options]) => JSON.parse(options!.body as string));
  expect(inputs[0]).toEqual(inputs[1]);
});
it('rejects oversized files before reading or sending', async () => {
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('File exceeds 5 MB.');
  expect(apiFetch).not.toHaveBeenCalled();
});
