import { createHash } from 'node:crypto';
import { compile, estimateTokens, parseMarkdown, type CompileOptions } from 'contexgin';
import {
  AgentCompiledBootContextSchema,
  PublishedContextPackSchema,
  type AgentContextRecipe,
  type PublishedContextPack,
  type ContextPackDocument,
} from '@mitzo/protocol';

export type ContextPackPin = Extract<AgentContextRecipe, { source: 'packs' }>['packs'][number];
/** Supplied by runtime admission. A portable pack never creates this authority. */
export interface AuthorizedContextPacks {
  sourceIdentity: string;
  resolve(pin: ContextPackPin): Promise<PublishedContextPack>;
  authorize(document: ContextPackDocument, signal?: AbortSignal): Promise<void>;
  readDocument(
    document: ContextPackDocument,
    signal?: AbortSignal,
  ): Promise<{ storeId: string; path: string; revision: string; content: string }>;
  assertCurrent(): void;
}
type Node = NonNullable<CompileOptions['nodes']>[number];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textDigest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const matches = (path: string[], prefix: string[]) =>
  prefix.every((part, index) => path[index]?.toLowerCase() === part.toLowerCase());
function sections(path: string, content: string, rejectAmbiguous = false): Node[] {
  const headings = new Set<string>();
  const result: Node[] = [];
  const add = (text: string, headingPath: string[]) => {
    if (text.trim())
      result.push({
        id: `${path}:${result.length}`,
        content: text,
        required: false,
        type: 'reference',
        tier: 'reference',
        tokenEstimate: estimateTokens(text),
        origin: { source: path, relativePath: path, format: 'markdown', headingPath },
      });
  };
  const tree = parseMarkdown(content);
  if (!tree.length) add(content, [path]);
  else {
    add(
      content
        .split('\n')
        .slice(0, tree[0].line - 1)
        .join('\n'),
      [path],
    );
    const visit = (heading: (typeof tree)[number], parent: string[]) => {
      const headingPath = [...parent, heading.title];
      const key = JSON.stringify(headingPath.map((part) => part.toLowerCase()));
      if (rejectAmbiguous && headings.has(key))
        throw Error(`Ambiguous context heading: ${headingPath.join(' > ')}`);
      headings.add(key);
      add(heading.content, headingPath);
      heading.children.forEach((child) => visit(child, headingPath));
    };
    tree.forEach((heading) => visit(heading, [path]));
  }
  return result;
}
export async function compileContextPacks(
  recipe: Extract<AgentContextRecipe, { source: 'packs' }>,
  packs?: AuthorizedContextPacks,
  signal?: AbortSignal,
) {
  if (!packs?.sourceIdentity)
    throw Error('Runtime source authorization is required for context packs');
  const documents: { storeId: string; path: string; revision: string; contentHash: string }[] = [];
  const omissions: { path: string; heading: string; reason: 'excluded' | 'budget' }[] = [];
  const candidates = new Map<string, { node: Node; priority: number; excluded: boolean }>();
  const sourceRevisions = new Map<string, string>();
  let totalBytes = 0;
  for (const pin of recipe.packs) {
    signal?.throwIfAborted();
    const pack = PublishedContextPackSchema.parse(await packs.resolve(pin));
    if (
      pack.id !== pin.id ||
      pack.revision !== pin.revision ||
      pack.hash !== pin.hash ||
      digest(pack.definition) !== pin.hash
    )
      throw Error('Selected context pack hash or revision mismatch');
    for (const selection of pack.definition.documents) {
      await packs.authorize(selection, signal);
      packs.assertCurrent();
      signal?.throwIfAborted();
      const source = await packs.readDocument(selection, signal);
      if (
        source.path !== selection.path ||
        source.revision !== selection.revision ||
        source.storeId !== packs.sourceIdentity
      )
        throw Error('Context source identity mismatch');
      const bytes = Buffer.byteLength(source.content, 'utf8');
      totalBytes += bytes;
      if (bytes > 65536 || totalBytes > 1048576 || source.content.includes('\0'))
        throw Error('Context source is too large or invalid');
      const identity = `${source.storeId}:${source.path}:${source.revision}`;
      if (sourceRevisions.has(source.path) && sourceRevisions.get(source.path) !== identity)
        throw Error('Context packs select conflicting source revisions');
      sourceRevisions.set(source.path, identity);
      const previous = documents.find((document) => document.path === source.path);
      if (previous && previous.contentHash !== textDigest(source.content))
        throw Error('Immutable context source content changed during composition');
      if (!previous)
        documents.push({
          storeId: source.storeId,
          path: source.path,
          revision: source.revision,
          contentHash: textDigest(source.content),
        });
      const sourceNodes = sections(source.path, source.content, selection.headings.length > 0);
      const selectors = selection.headings.map((heading) => [selection.path, ...heading]);
      if (
        selectors.some(
          (selector) => !sourceNodes.some((node) => matches(node.origin.headingPath!, selector)),
        )
      )
        throw Error(`Selected context heading is unavailable: ${source.path}`);
      for (const node of sourceNodes.filter(
        (node) =>
          !selectors.length ||
          selectors.some((selector) => matches(node.origin.headingPath!, selector)),
      )) {
        node.required = selection.mode === 'required';
        const excluded = selection.mode === 'excluded';
        const existing = candidates.get(node.id);
        if (
          existing &&
          (existing.node.required || node.required) &&
          (existing.excluded || excluded)
        )
          throw Error('Context packs exclude required content');
        candidates.set(node.id, {
          node: { ...node, required: node.required || existing?.node.required },
          priority: Math.max(selection.priority, existing?.priority ?? 0),
          excluded: excluded || existing?.excluded === true,
        });
        if (candidates.size > 500) throw Error('Context packs contain too many sections');
      }
    }
    if (pack.definition.retrievalGuidance.trim()) {
      const path = `context-pack:${pin.id}/retrieval-guidance`;
      for (const node of sections(path, pack.definition.retrievalGuidance)) {
        node.required = true;
        candidates.set(node.id, { node, priority: 100, excluded: false });
      }
    }
  }
  const nodes = [...candidates.values()]
    .sort((left, right) => right.priority - left.priority)
    .flatMap((candidate) => {
      if (candidate.excluded) {
        omissions.push({
          path: candidate.node.origin.relativePath,
          heading: candidate.node.origin.headingPath!.join(' > '),
          reason: 'excluded',
        });
        return [];
      }
      return [candidate.node];
    });
  if (!nodes.length || nodes.length > 500)
    throw Error('Context packs contain no content or too many sections');
  const compiled = await compile({ workspaceRoot: '/', nodes, tokenBudget: recipe.tokenBudget });
  signal?.throwIfAborted();
  packs.assertCurrent();
  const serialize = (values: typeof compiled.included) =>
    values.map((section) => ({
      source: section.source.relativePath,
      heading: section.headingPath.join(' > '),
      tokens: section.tokenEstimate,
      content: section.content,
    }));
  omissions.push(
    ...compiled.trimmed.map((section) => ({
      path: section.source.relativePath,
      heading: section.headingPath.join(' > '),
      reason: 'budget' as const,
    })),
  );
  return {
    provenance: { packs: recipe.packs, documents, omissions },
    context: AgentCompiledBootContextSchema.parse({
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: compiled.sources.length,
      tokenCount: compiled.bootTokens,
      tokenBudget: recipe.tokenBudget,
      sources: compiled.sources.map((source) => ({ path: source.relativePath, kind: source.kind })),
      included: serialize(compiled.included),
      trimmed: serialize(compiled.trimmed),
      fullMarkdown: compiled.bootPayload,
    }),
  };
}
