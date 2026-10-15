import { useLayoutEffect, useRef } from 'react';
import { getApiBaseUrl } from '../lib/api-base-url';

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
  return <IsolatedHtmlPreview key={html} html={html} title={title} className={className} />;
}

function IsolatedHtmlPreview({ html, title, className = '' }: Props) {
  const delivered = useRef(false);
  useLayoutEffect(() => {
    // Native webviews do not inherit the server's parent policy. Restrict frame
    // destinations before delivering scripts, including self-navigation attempts.
    const base = getApiBaseUrl();
    const server = base ? new URL(base, window.location.href) : null;
    const origin = server && ['http:', 'https:'].includes(server.protocol) ? server.origin : '';
    const policy = `frame-src 'self' ${origin}`.trim();
    if (
      Array.from(
        document.head.querySelectorAll<HTMLMetaElement>('meta[data-mitzo-preview-policy]'),
      ).some((meta) => meta.content === policy)
    )
      return;
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = policy;
    meta.dataset.mitzoPreviewPolicy = '';
    document.head.append(meta);
    // The server base is build-constant. Keep this narrowing policy installed:
    // removing a CSP meta element does not revoke its already-applied policy.
  }, []);
  return (
    <iframe
      className={`html-preview${className ? ` ${className}` : ''}`}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`${getApiBaseUrl()}/api/html-preview`}
      onLoad={(event) => {
        // document.write in the shell emits another load. Never send twice or
        // send artifact bytes again if its document navigates elsewhere.
        if (delivered.current) return;
        delivered.current = true;
        event.currentTarget.contentWindow?.postMessage(
          { type: 'mitzo:render-preview', html: buildHtmlPreviewDocument(html) },
          '*', // The allow-scripts-only sandbox has an opaque origin.
        );
      }}
    />
  );
}
