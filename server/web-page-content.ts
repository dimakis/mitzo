import { parse, defaultTreeAdapter as tree, type DefaultTreeAdapterTypes } from 'parse5';

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
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);
type Node = DefaultTreeAdapterTypes.Node;

/** Inert HTML parsing: no scripts, styles, external resources or secondary requests. */
export function webPageContent(body: string, contentType: string, sourceUrl: string): string {
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType)) return body;
  const document = parse(body);
  let root: Node = document;
  const candidates: Node[] = [document];
  while (candidates.length) {
    const node = candidates.pop()!;
    if (tree.isElementNode(node) && node.tagName === 'main') {
      root = node;
      break;
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) candidates.push(node.childNodes[i]!);
  }
  const parts: string[] = [];
  const pending: (Node | string)[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    if (tree.isTextNode(node)) {
      parts.push(node.value);
      continue;
    }
    if (tree.isElementNode(node)) {
      if (omitted.has(node.tagName)) continue;
      if (blocks.has(node.tagName)) {
        parts.push('\n');
        pending.push('\n');
      }
      if (node.tagName === 'a') {
        const href = node.attrs.find((attr) => attr.name === 'href')?.value;
        if (href) {
          try {
            const url = new URL(href, sourceUrl);
            if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
              pending.push(` (${url.href})`);
          } catch {
            /* Invalid links remain plain source text. */
          }
        }
      }
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
  }
  return parts
    .join('')
    .replace(/[\t \f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
