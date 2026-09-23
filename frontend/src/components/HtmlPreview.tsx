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
].join('; ');

function buildHtmlPreviewDocument(html: string): string {
  const securityMeta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const head = /<head(?:\s[^>]*)?>/i;

  if (head.test(html)) return html.replace(head, (match) => `${match}${securityMeta}`);

  const htmlTag = /<html(?:\s[^>]*)?>/i;
  if (htmlTag.test(html)) {
    return html.replace(htmlTag, (match) => `${match}<head>${securityMeta}</head>`);
  }

  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '<!doctype html>';
  const body = html.slice(html.startsWith(doctype) ? doctype.length : 0);
  return `${doctype}<html><head>${securityMeta}</head><body>${body}</body></html>`;
}

export function HtmlPreview({ html, title, className = '' }: Props) {
  return (
    <iframe
      className={`html-preview${className ? ` ${className}` : ''}`}
      title={title}
      sandbox="allow-scripts"
      srcDoc={buildHtmlPreviewDocument(html)}
    />
  );
}
