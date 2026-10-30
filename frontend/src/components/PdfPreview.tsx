import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { loadPdf } from '../lib/pdf-document';
import { apiFetch } from '../lib/api-fetch';

const maxBytes = 5 * 1024 * 1024;
/** Authenticated retained bytes; one selected page and one bounded canvas. No
 * PDF scripts, external viewer service, all-page images or background prefetch. */
export function PdfPreview({ url, title }: { url: string; title: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [renderedKey, setRenderedKey] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const renderKey = JSON.stringify([url, page, zoom, width]);
  const rendering = renderedKey !== renderKey;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let loading: ReturnType<typeof loadPdf> | undefined;
    setPdf(undefined);
    setPage(1);
    setZoom(1);
    setError('');
    void (async () => {
      const response = await apiFetch(url, { signal: controller.signal });
      if (!response.ok) throw Error('This saved PDF is unavailable.');
      if (Number(response.headers.get('content-length')) > maxBytes)
        throw Error('This PDF exceeds the preview limit.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      controller.signal.throwIfAborted();
      if (bytes.length > maxBytes || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-')
        throw Error('This saved file is not a supported PDF.');
      loading = loadPdf(bytes);
      const document = await loading.promise;
      if (!controller.signal.aborted) setPdf(document);
    })().catch((failure: unknown) => {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'PDF preview unavailable.');
    });
    return () => {
      controller.abort();
      void loading?.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    let release: (() => void) | undefined;
    setError('');
    void (async () => {
      const selected = await pdf.getPage(page);
      if (cancelled) {
        selected.cleanup();
        return;
      }
      release = () => selected.cleanup();
      const element = canvas.current;
      const context = element?.getContext('2d');
      if (!element || !context) throw Error('PDF rendering is unavailable in this browser.');
      const original = selected.getViewport({ scale: 1 });
      const scale = Math.min(
        (width / original.width) * zoom * Math.min(window.devicePixelRatio || 1, 2),
        4096 / Math.max(original.width, original.height),
      );
      const viewport = selected.getViewport({ scale });
      element.width = Math.ceil(viewport.width);
      element.height = Math.ceil(viewport.height);
      task = selected.render({ canvas: element, canvasContext: context, viewport });
      await task.promise;
      if (!cancelled) setRenderedKey(renderKey);
    })().catch(() => {
      if (!cancelled) {
        setError('Unable to render this PDF page. Use the file options to download the original.');
        setRenderedKey(renderKey);
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
      release?.();
    };
  }, [pdf, page, zoom, width, renderKey]);
  return (
    <section className="pdf-preview" aria-label={`${title} PDF`}>
      {error ? (
        <p role="alert">{error}</p>
      ) : !pdf ? (
        <p role="status">Loading PDF…</p>
      ) : (
        <>
          <div className="home-inline-actions pdf-preview-controls">
            <button
              className="home-secondary"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous page
            </button>
            <span>
              Page {page} of {pdf.numPages}
            </span>
            <button
              className="home-secondary"
              disabled={page === pdf.numPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next page
            </button>
            <label>
              Zoom{' '}
              <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
                <option value={1}>Fit width</option>
                <option value={1.5}>150%</option>
                <option value={2}>200%</option>
              </select>
            </label>
          </div>
          {rendering && <p role="status">Rendering page…</p>}
        </>
      )}
      <div className="pdf-preview-page" ref={container}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${title} — page ${page}`}
          style={{ width: `${zoom * 100}%` }}
          hidden={!pdf || !!error || rendering}
        />
      </div>
    </section>
  );
}
