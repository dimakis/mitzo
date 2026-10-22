// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pdfToImages } from '../pdf-to-images';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), worker: { workerSrc: '' } }));
vi.mock('pdfjs-dist', () => ({ getDocument: pdf.getDocument, GlobalWorkerOptions: pdf.worker }));

function file(size = 10): File {
  return {
    name: 'report.pdf',
    size,
    arrayBuffer: vi.fn(async () => new ArrayBuffer(10)),
  } as unknown as File;
}

let destroy: ReturnType<typeof vi.fn>;
let renderPage: ReturnType<typeof vi.fn>;
let getPage: ReturnType<typeof vi.fn>;
let cleanupPage: ReturnType<typeof vi.fn>;
function documentWithPages(numPages: number) {
  cleanupPage = vi.fn();
  renderPage = vi.fn(() => ({ promise: Promise.resolve() }));
  getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: renderPage,
    cleanup: cleanupPage,
  }));
  destroy = vi.fn(async () => {});
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages, getPage }), destroy });
}

beforeEach(() => {
  documentWithPages(2);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,cGFnZQ==',
  );
});
afterEach(() => vi.restoreAllMocks());

describe('PDF import', () => {
  it('renders every page in order as labeled image input, including scanned PDFs', async () => {
    const result = await pdfToImages(file(), 10);
    expect(result).toEqual(
      [1, 2].map((page) => ({
        data: 'cGFnZQ==',
        mediaType: 'image/jpeg',
        preview: 'data:image/jpeg;base64,cGFnZQ==',
        name: `report.pdf — page ${page} of 2`,
      })),
    );
    expect(getPage.mock.calls).toEqual([[1], [2]]);
    expect(renderPage).toHaveBeenCalledTimes(2);
    expect(cleanupPage).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
    expect(pdf.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        cMapUrl: '/pdfjs/cmaps/',
        wasmUrl: '/pdfjs/wasm/',
        stopAtErrors: true,
      }),
    );
  });

  it('rejects a document that exceeds the remaining page slots without truncating it', async () => {
    await expect(pdfToImages(file(), 1)).rejects.toThrow(/2 pages.*1.*available/i);
    expect(getPage).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejects oversized PDFs before reading them', async () => {
    const large = file(21 * 1024 * 1024);
    await expect(pdfToImages(large, 10)).rejects.toThrow(/20 MB/);
    expect(large.arrayBuffer).not.toHaveBeenCalled();
  });

  it('releases the worker when a PDF is corrupt or encrypted', async () => {
    pdf.getDocument.mockReturnValue({
      promise: Promise.reject(new Error('Password required')),
      destroy,
    });
    await expect(pdfToImages(file(), 10)).rejects.toThrow(/Password required/);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('discards partial results and releases resources if a page cannot render', async () => {
    renderPage.mockReturnValueOnce({ promise: Promise.resolve() });
    renderPage.mockReturnValueOnce({ promise: Promise.reject(new Error('Invalid page')) });
    await expect(pdfToImages(file(), 10)).rejects.toThrow('Invalid page');
    expect(cleanupPage).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
  });
});

it('rejects documents whose rendered pages exceed the upload budget', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    `data:image/jpeg;base64,${'A'.repeat(18 * 1024 * 1024)}`,
  );
  await expect(pdfToImages(file(), 10)).rejects.toThrow(/12 MB/);
  expect(destroy).toHaveBeenCalledOnce();
});
