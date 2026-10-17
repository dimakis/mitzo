import { parse, defaultTreeAdapter as tree, type DefaultTreeAdapterTypes } from 'parse5';
import { WebAccessError } from './request-web-access.js';
import { githubReadSummary } from './github-read-summary.js';

// Transport resource guard, distinct from model output or readable-article budgets.
export const MAX_WEB_DOWNLOAD_BYTES = 2 * 1024 * 1024;
export const WEB_DOWNLOAD_LIMIT_ERROR = 'Approved read exceeded the 2 MB download safety limit.';
const omitted = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'footer',
]);
const blocks = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'li',
  'ul',
  'ol',
  'br',
  'tr',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
type Node = DefaultTreeAdapterTypes.Node;

/** Inert HTML parsing: no scripts, styles, external resources or secondary requests. */
export function webPageContent(
  body: string,
  contentType: string,
  sourceUrl: string,
  linkHeader?: string,
  view?: 'summary' | 'full',
): string {
  if (view !== 'full' && /^application\/json(?:;|$)/i.test(contentType))
    return githubReadSummary(body, sourceUrl, linkHeader);
  // XML, including XHTML, retains its original self-closing and namespace semantics.
  if (!/^text\/html(?:;|$)/i.test(contentType)) return body;
  const document = parse(body);
  let root: Node = document;
  let foundMain = false;
  let base = new URL(sourceUrl);
  let foundBase = false;
  const candidates: Node[] = [document];
  while (candidates.length) {
    const node = candidates.pop()!;
    if (tree.isElementNode(node) && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      if (!foundMain && node.tagName === 'main') {
        root = node;
        foundMain = true;
      }
      if (!foundBase && node.tagName === 'base') {
        const href = node.attrs.find((attr) => attr.name === 'href')?.value;
        if (href !== undefined) {
          try {
            const candidate = new URL(href, sourceUrl);
            if (
              ['http:', 'https:'].includes(candidate.protocol) &&
              !candidate.username &&
              !candidate.password
            ) {
              base = candidate;
              foundBase = true;
            }
          } catch {
            /* Invalid base declarations do not replace the source URL. */
          }
        }
      }
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) candidates.push(node.childNodes[i]!);
  }
  // Link normalization may add at most the input's byte count. Compact references
  // retain every destination and its base without repeating a long URL prefix.
  let expansionBytes = Buffer.byteLength(body);
  const baseBytes = Buffer.byteLength(base.href);
  const originalLinks = new Set<string>();
  const expandedLinks = new Set<string>();
  let references = false;
  const linkSuffix = (href: string): string | undefined => {
    if (originalLinks.has(href)) return;
    originalLinks.add(href);
    try {
      // Validate schemes/credentials without repeatedly expanding a huge document base.
      const probe = new URL(href, `${base.protocol}//mitzo.invalid/`);
      if (!['http:', 'https:'].includes(probe.protocol) || probe.username || probe.password) return;
      if (baseBytes <= expansionBytes) {
        const destination = new URL(href, base);
        if (expandedLinks.has(destination.href)) return;
        const addedBytes = Math.max(
          0,
          Buffer.byteLength(destination.href) - Buffer.byteLength(href),
        );
        if (addedBytes <= expansionBytes) {
          expansionBytes -= addedBytes;
          expandedLinks.add(destination.href);
          return ` (${destination.href})`;
        }
      }
      references = true;
      return ` (URL reference: ${href === '' ? '""' : href})`;
    } catch {
      return;
    }
  };
  const parts: string[] = [];
  const pending: ({ node: Node; preformatted: boolean } | string)[] = [
    { node: root, preformatted: false },
  ];
  const lineBreak = () => {
    if (!parts.at(-1)?.endsWith('\n')) parts.push('\n');
  };
  while (pending.length) {
    const entry = pending.pop()!;
    if (typeof entry === 'string') {
      if (entry === '\n') lineBreak();
      else parts.push(entry);
      continue;
    }
    const { node } = entry;
    let preformatted = entry.preformatted;
    if (tree.isTextNode(node)) {
      const text = preformatted ? node.value : node.value.replace(/\s+/g, ' ');
      if (text !== ' ' || !parts.at(-1)?.endsWith('\n')) parts.push(text);
      continue;
    }
    if (tree.isElementNode(node)) {
      if (omitted.has(node.tagName)) continue;
      if (node.tagName === 'pre') {
        preformatted = true;
        parts.push('\n~~~\n');
        pending.push('\n~~~\n');
      } else if (blocks.has(node.tagName)) {
        lineBreak();
        pending.push('\n');
      }
      if (node.tagName === 'a') {
        const href = node.attrs.find((attr) => attr.name === 'href')?.value;
        if (href !== undefined) {
          const suffix = linkSuffix(href);
          if (suffix) pending.push(suffix);
        }
      }
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        pending.push({ node: node.childNodes[i]!, preformatted });
  }
  const content = parts.join('').trim();
  if (!content)
    throw new WebAccessError(
      'The website returned no readable content. It may require JavaScript or an interactive browser.',
    );
  return (references ? `URL references resolve against: ${base.href}\n\n` : '') + content;
}
