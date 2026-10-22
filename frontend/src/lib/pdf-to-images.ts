import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ImageAttachment } from '../types/chat';

// Bundle the worker locally: importing a private PDF must not contact a CDN.
GlobalWorkerOptions.workerSrc = workerUrl;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_DIMENSION = 2000;
const MAX_RENDERED_BYTES = 12 * 1024 * 1024;

/** Render all pages or reject the whole import. Never silently omit pages. */
export async function pdfToImages(file: File, available: number): Promise<ImageAttachment[]> {
  if (file.size > MAX_PDF_BYTES) throw new Error('PDFs must be 20 MB or smaller.');
  if (available < 1) throw new Error('Remove an attachment before importing a PDF.');
  const loading = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
    wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
    stopAtErrors: true,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > available)
      throw new Error(
        `PDF has ${pdf.numPages} pages; ${available} page slots available. Split the PDF or remove attachments.`,
      );
    const images: ImageAttachment[] = [];
    let bytes = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const canvas = document.createElement('canvas');
      try {
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(2, MAX_PAGE_DIMENSION / Math.max(original.width, original.height)),
        });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('PDF rendering is unavailable in this browser.');
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const preview = canvas.toDataURL('image/jpeg', 0.9);
        const data = preview.split(',')[1];
        if (!data) throw new Error(`Could not render PDF page ${number}.`);
        bytes += Math.ceil((data.length * 3) / 4);
        if (bytes > MAX_RENDERED_BYTES)
          throw new Error('Rendered PDF exceeds 12 MB. Split the PDF into smaller files.');
        images.push({
          data,
          mediaType: 'image/jpeg',
          preview,
          name: `${file.name} — page ${number} of ${pdf.numPages}`,
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return images;
  } finally {
    await loading.destroy();
  }
}
