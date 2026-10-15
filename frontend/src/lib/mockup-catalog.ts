import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Nodes, Link, LinkReference, Definition, PhrasingContent } from 'mdast';
import { absoluteMarkdownArtifactPath, decodeFilePathUrl, FILE_SCHEME } from './file-paths';
import type { FinishedMessage } from '../types/chat';

export interface MockupRevision {
  path: string;
  number: number | null;
  messageId: string;
}
export interface Mockup {
  id: string;
  title: string;
  revisions: MockupRevision[];
}
const parser = unified().use(remarkParse);
const label = (nodes: PhrasingContent[]): string =>
  nodes
    .map((node) => ('value' in node ? node.value : 'children' in node ? label(node.children) : ''))
    .join('');

/** Transcript references only: discovery never proves that a file exists or grants access. */
export function collectMockups(messages: FinishedMessage[]): Mockup[] {
  const catalog = new Map<string, Mockup>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.blockType !== 'text' || !block.content) continue;
      const tree = parser.parse(block.content) as Root;
      const definitions = new Map<string, Definition>();
      const walk = (node: Nodes, visit: (node: Link | LinkReference | Definition) => void) => {
        if (node.type === 'link' || node.type === 'linkReference' || node.type === 'definition')
          visit(node);
        if ('children' in node) for (const child of node.children) walk(child, visit);
      };
      walk(tree, (node) => {
        if (node.type === 'definition' && !definitions.has(node.identifier))
          definitions.set(node.identifier, node);
      });
      walk(tree, (node) => {
        if (node.type === 'definition') return;
        const href = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
        if (!href) return;
        const path = href.startsWith(FILE_SCHEME)
          ? decodeFilePathUrl(href)
          : absoluteMarkdownArtifactPath(href);
        if (!path || !/\.html?$/i.test(path)) return;
        const version = /^(.*\/mockups\/[^/]+)\/v([0-9]+)\.html$/i.exec(path);
        const number = version ? Number(version[2]) : null;
        const validVersion = version && Number.isSafeInteger(number) && number! > 0;
        const id = validVersion ? version[1] : path;
        let mockup = catalog.get(id);
        if (!mockup) {
          mockup = {
            id,
            title: label(node.children).trim() || path.split('/').pop()!,
            revisions: [],
          };
        }
        mockup.revisions = mockup.revisions.filter((revision) => revision.path !== path);
        mockup.revisions.push({
          path,
          number: validVersion ? number : null,
          messageId: message.messageId,
        });
        mockup.revisions.sort(
          (a, b) => (b.number ?? 0) - (a.number ?? 0) || b.path.localeCompare(a.path),
        );
        // Most recently mentioned designs are easiest to find again.
        catalog.delete(id);
        catalog.set(id, mockup);
      });
    }
  }
  return [...catalog.values()].reverse();
}
