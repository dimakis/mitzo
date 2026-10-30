// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PdfPreview } from '../PdfPreview';
import { apiFetch } from '../../lib/api-fetch';
const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), worker: { workerSrc: '' } }));
vi.mock('pdfjs-dist', () => ({ getDocument: pdf.getDocument, GlobalWorkerOptions: pdf.worker }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const getPage = vi.fn(),
  destroy = vi.fn(),
  cancel = vi.fn(),
  releasePage = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue(new Response('%PDF-1.7 synthetic'));
  getPage.mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel }),
    cleanup: releasePage,
  });
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 10, getPage }), destroy });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('fetches the retained PDF once and renders only the selected page, releasing resources on close', async () => {
  const view = render(
    <PdfPreview url="/api/telos/artifacts/retained?revision=2" title="Associate QC" />,
  );
  await screen.findByText('Page 1 of 10');
  await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Page 2 of 10');
  await waitFor(() => expect(getPage).toHaveBeenCalledWith(2));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(getPage.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  expect(pdf.getDocument).toHaveBeenCalledWith(expect.objectContaining({ stopAtErrors: true }));
  expect(screen.getByRole('img', { name: 'Associate QC — page 2' })).toBeTruthy();
  view.unmount();
  expect(destroy).toHaveBeenCalledOnce();
  expect(releasePage).toHaveBeenCalled();
});
it('keeps failures explicit without trying other files or remote PDF services', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 403 }));
  render(<PdfPreview url="/api/telos/artifacts/retained?revision=2" title="Associate QC" />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(pdf.getDocument).not.toHaveBeenCalled();
});
