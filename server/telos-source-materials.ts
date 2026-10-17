import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {
  FILE_SCHEME,
  decodeFilePathUrl,
  linkifyFilePaths,
  isTelosArtifactUrl,
} from '@mitzo/protocol';

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = {
  type: string;
  url?: string;
  identifier?: string;
  children?: Node[];
};

/** Use the renderer's parser and pure path normalization. Only actual link or
 * image destinations count; never code, HTML literals, labels or link titles.
 */
export function telosMaterialDestinations(content: string): string[] {
  // Match completed chat preprocessing before resolving Markdown destinations.
  const tree = parser.parse(linkifyFilePaths(content));
  const definitions = new Map<string, string>();
  const collect = (node: Node) => {
    if (node.type === 'definition' && node.identifier && node.url) {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    }
    node.children?.forEach(collect);
  };
  collect(tree);
  const destinations = new Set<string>();
  const add = (url: string) => {
    const path = url.startsWith(FILE_SCHEME) ? decodeFilePathUrl(url) : url;
    if (path && isTelosArtifactUrl(path)) destinations.add(path);
  };
  const visit = (node: Node) => {
    if (node.type === 'link' || node.type === 'image') {
      if (node.url) add(node.url);
      return;
    }
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      const url = node.identifier ? definitions.get(node.identifier) : undefined;
      if (url) add(url);
      return;
    }
    if (['definition', 'code', 'inlineCode', 'html'].includes(node.type)) return;
    node.children?.forEach(visit);
  };
  visit(tree);
  return [...destinations];
}
