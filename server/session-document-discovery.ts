import { unified } from 'unified';
import remarkParse from 'remark-parse';
import {
  absoluteMarkdownArtifactPath,
  relativeArtifactPath,
  detectFilePaths,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';

export interface WorkspaceDocument {
  path: string;
  title: string;
  evidence: 'created' | 'linked';
}
// Deliverable types only. Repository source changes and credential files are not a document catalog.
export function isDocumentPath(path: string): boolean {
  return (
    path.length <= 4096 &&
    !path.includes('\\') &&
    [...path].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    /\.(?:md|markdown|txt|csv|tsv|json|ya?ml|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|svg|html?)$/i.test(
      path,
    ) &&
    !path
      .split('/')
      .some((part) => part === '..' || /^\.env/i.test(part) || /^credentials?/i.test(part)) &&
    !/^\/(?:api|files|chat|sessions)(?:\/|$)/.test(path)
  );
}
/** Bounded replay of provider-neutral retained events; a link never proves file custody. */
export function discoverSessionDocuments(
  store: EventStore,
  sessionId: string,
): WorkspaceDocument[] {
  const found = new Map<string, WorkspaceDocument>();
  const add = (path: unknown, evidence: WorkspaceDocument['evidence'], title?: string) => {
    if (typeof path !== 'string' || !isDocumentPath(path) || found.size >= 100) return;
    const old = found.get(path);
    if (!old || evidence === 'created')
      found.set(path, {
        path,
        evidence,
        title: (title || path.split('/').pop() || path).slice(0, 200),
      });
  };
  const results = new Map(
    store
      .getEventsOfType(sessionId, 'tool_result', 512)
      .filter((event) => event.seatId == null)
      .map((event) => [event.payload.toolId, event]),
  );
  for (const event of store.getEventsOfType(sessionId, 'block_end', 512)) {
    if (event.seatId != null) continue;
    const result = results.get(event.payload.toolId);
    if (!result || result.seq <= event.seq || result.payload.isError !== false) continue;
    const raw = event.payload.rawInput as { type?: string; path?: string } | undefined;
    if (raw?.type === 'write' || raw?.type === 'diff') add(raw.path, 'created');
  }
  let remaining = 1024 * 1024;
  for (const candidate of store.listSessionOutputCandidates(sessionId, 100)) {
    if ((remaining -= Buffer.byteLength(candidate.content)) < 0) break;
    const tree = unified().use(remarkParse).parse(candidate.content);
    const visit = (node: {
      type: string;
      url?: string;
      value?: string;
      children?: typeof tree.children;
    }) => {
      if ((node.type === 'link' || node.type === 'definition') && node.url) {
        const path = absoluteMarkdownArtifactPath(node.url) ?? relativeArtifactPath(node.url);
        if (path) add(path, 'linked');
      }
      node.children?.forEach(visit);
    };
    visit(tree);
    for (const match of detectFilePaths(candidate.content)) add(match.path, 'linked');
  }
  return [...found.values()];
}
