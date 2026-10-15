import { Router } from 'express';

/** An HTTP document owns its policy; srcdoc/blob documents inherit the host CSP. */
export const HTML_PREVIEW_BOOTSTRAP = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body><script>
window.addEventListener('message', function render(event) {
  if (event.source !== parent || !event.data || event.data.type !== 'mitzo:render-preview' || typeof event.data.html !== 'string') return;
  window.removeEventListener('message', render);
  document.open();
  document.write(event.data.html);
  document.close();
});
</script></body></html>`;

function parentOrigin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:', 'capacitor:', 'ionic:'].includes(url.protocol) ||
    !url.host ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  )
    throw Error('HTML preview requires exact configured parent origins');
  return `${url.protocol}//${url.host}`;
}

export function htmlPreviewPolicy(parentOrigins: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' blob:",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    'sandbox allow-scripts',
    `frame-ancestors 'self' ${parentOrigins.map(parentOrigin).join(' ')}`.trim(),
  ].join('; ');
}

export function createHtmlPreviewRouter(parentOrigins: readonly string[] = []) {
  const router = Router();
  const policy = htmlPreviewPolicy(parentOrigins);
  // The public shell contains no artifact, credential or file path. The parent
  // transfers already-authorized bytes after load; there is no host command API.
  router.get('/api/html-preview', (_req, res) => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // frame-ancestors replaces SAMEORIGIN for configured Capacitor origins.
    res.removeHeader('X-Frame-Options');
    res.type('html').send(HTML_PREVIEW_BOOTSTRAP);
  });
  return router;
}
