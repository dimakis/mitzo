// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
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
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File(['safe notes'], 'notes.md', { type: 'text/markdown' })] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Saved revision 2.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Upload' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.pdf')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('File exceeds 5 MB.');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('clears native picker value after retaining the File so selecting the same path refreshes bytes', async () => {
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  const input = screen.getByLabelText('File to upload') as HTMLInputElement;
  Object.defineProperty(input, 'value', {
    configurable: true,
    writable: true,
    value: 'C:\\fakepath\\notes.md',
  });
  fireEvent.change(input, { target: { files: [new File(['notes'], 'notes.md')] } });
  expect(input.value).toBe('');
  expect(screen.getByText('Selected file: notes.md')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Upload file' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it('opens a named drawer, traps keyboard focus and restores the Upload action on Escape', () => {
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByLabelText('File to upload')).toBeNull();
  const opener = screen.getByRole('button', { name: 'Upload' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Upload output' });
  const close = screen.getByRole('button', { name: 'Close upload' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByLabelText('File title (optional)'));
  fireEvent.keyDown(dialog, { key: 'Tab' });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('preserves a selected file across drawer close and reopen', () => {
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File(['notes'], 'notes.md')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Close upload' }));
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  expect(screen.getByText('Selected file: notes.md')).toBeTruthy();
});

it('allows closing during upload without losing its receipt or aborting the request', async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  const opener = screen.getByRole('button', { name: 'Upload' });
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File(['notes'], 'notes.md')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal as AbortSignal;
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(signal.aborted).toBe(false);
  expect(document.activeElement).toBe(opener);
  await act(async () =>
    resolve({ ok: true, json: async () => ({ artifact: { revision: 3 } }) } as Response),
  );
  await screen.findByText('Saved revision 3.');
});

it('chooses a supported camera photo without auto-upload and retries the same bytes', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ artifact: { revision: 1 } }),
    } as Response);
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  const camera = screen.getByLabelText('Photo to upload') as HTMLInputElement;
  expect(camera.accept).toBe('image/jpeg,image/png,image/webp');
  expect(camera.getAttribute('capture')).toBe('environment');
  const picker = vi.spyOn(camera, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
  expect(picker).toHaveBeenCalledTimes(1);
  fireEvent.change(camera, {
    target: {
      files: [new File([new Uint8Array([255, 216, 255, 1])], 'photo.jpg', { type: 'image/jpeg' })],
    },
  });
  expect(apiFetch).not.toHaveBeenCalled();
  expect(screen.getByText('Selected file: photo.jpg')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Offline');
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Saved revision 1.');
  const inputs = vi
    .mocked(apiFetch)
    .mock.calls.map(([, options]) => JSON.parse(options!.body as string));
  expect(inputs[0]).toEqual(inputs[1]);
  expect(inputs[0]).toMatchObject({
    filename: 'photo.jpg',
    base64: btoa(String.fromCharCode(255, 216, 255, 1)),
  });
});

it('keeps the selected file and retry request when camera capture is canceled', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ artifact: { revision: 1 } }),
    } as Response);
  render(<UserOutputUpload itemId="work" onUploaded={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  fireEvent.change(screen.getByLabelText('File to upload'), {
    target: { files: [new File(['notes'], 'notes.md')] },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Offline');
  fireEvent.change(screen.getByLabelText('Photo to upload'), { target: { files: [] } });
  expect(screen.getByText('Selected file: notes.md')).toBeTruthy();
  expect(screen.getByText('Offline')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Upload file' }));
  await screen.findByText('Saved revision 1.');
  const inputs = vi
    .mocked(apiFetch)
    .mock.calls.map(([, options]) => JSON.parse(options!.body as string));
  expect(inputs[0]).toEqual(inputs[1]);
});
