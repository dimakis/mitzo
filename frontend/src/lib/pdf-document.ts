import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

// All private PDF paths share the bundled worker/fonts; no CDN or document code.
GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdfjs/pdf.worker.min.mjs`;
export function loadPdf(data: Uint8Array) {
  return getDocument({
    data,
    stopAtErrors: true,
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
  });
}
