interface Props {
  html: string;
  title: string;
  className?: string;
}

const PREVIEW_CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ');

function buildHtmlPreviewDocument(html: string): string {
  const securityMeta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const referrerMeta = '<meta name="referrer" content="no-referrer">';

  // The trusted head must precede the artifact verbatim. Searching untrusted markup
  // for a head tag can match text inside a comment or attribute and leave the CSP
  // inactive.
  return `<!doctype html><html><head>${securityMeta}${referrerMeta}</head><body>${html}</body></html>`;
}

export function HtmlPreview({ html, title, className = '' }: Props) {
  return (
    <iframe
      className={`html-preview${className ? ` ${className}` : ''}`}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={buildHtmlPreviewDocument(html)}
    />
  );
}
