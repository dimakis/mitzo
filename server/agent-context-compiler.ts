import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { compile, estimateTokens, parseMarkdown, type CompileOptions } from 'contexgin';
import {
  AgentContextRecipeSchema,
  AgentCompiledBootContextSchema,
  CompiledAgentContextSchema,
  type AgentContextRecipe,
  type CompiledAgentContext,
} from '@mitzo/protocol';
import { z } from 'zod';
import { DEFAULT_CONTEXGIN_URL } from './constants.js';
import { isPrivateCodexPath } from './codex-private-path.js';

// Pinned dependency plus this preloaded-document compiler contract; never a runtime grant.
export const AGENT_CONTEXT_COMPILER_REVISION =
  'mitzo-context-v3:contexgin-683f9007db686e710ed9a5410468fe33df1c5382';
export const contextDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Options = {
  workspaceRoot?: string;
  contexginUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};
type Node = NonNullable<CompileOptions['nodes']>[number];

async function rootIdentity(options: Options) {
  if (!options.workspaceRoot) throw Error('Select a chat workspace for context compilation');
  return realpath(options.workspaceRoot);
}
function assertAllowedDocument(root: string, reference: string) {
  if (isPrivateCodexPath(join(root, reference)))
    throw Error(`Context document is not allowed: ${reference}`);
}
async function document(
  root: string,
  reference: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  assertAllowedDocument(root, reference);
  let current = root;
  for (const [index, part] of reference.split('/').entries()) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink()) throw Error(`Context symlink is unsupported: ${reference}`);
    if (index < reference.split('/').length - 1 && !info.isDirectory())
      throw Error(`Context parent is not a directory: ${reference}`);
    if (index === reference.split('/').length - 1 && !info.isFile())
      throw Error(`Context document is not a regular file: ${reference}`);
  }
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error(`Context document is not a regular file: ${reference}`);
    if (info.size > 65536) throw Error(`Context document is too large: ${reference}`);
    const resolved = await realpath(current);
    if (isPrivateCodexPath(resolved)) throw Error(`Context document is not allowed: ${reference}`);
    const within = relative(root, resolved);
    if (within === '..' || within.startsWith('..' + sep) || isAbsolute(within))
      throw Error(`Context document escapes its workspace: ${reference}`);
    const target = await lstat(resolved);
    if (target.dev !== info.dev || target.ino !== info.ino)
      throw Error(`Context document changed during selection: ${reference}`);
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
      size += bytesRead;
      if (!bytesRead) break;
    }
    if (size > 65536) throw Error(`Context document is too large: ${reference}`);
    signal?.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    await handle.close();
  }
}
function node(
  file: string,
  content: string,
  headingPath: string[],
  index: number,
  required = false,
): Node {
  return {
    id: required ? file : `${file}:${index}`,
    content,
    required,
    type: required ? 'governance' : 'reference',
    tier: required ? 'constitutional' : 'reference',
    tokenEstimate: estimateTokens(content),
    origin: { source: file, relativePath: file, format: 'markdown', headingPath },
  };
}
async function workspaceContext(
  recipe: Extract<AgentContextRecipe, { source: 'workspace' }>,
  options: Options,
) {
  const root = await rootIdentity(options);
  const nodes: Node[] = [];
  let canonical: string | undefined;
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const content = await document(root, file, options.signal);
    if (content !== null) {
      if (!content.trim()) throw Error(`Required workspace instructions are empty: ${file}`);
      canonical = file;
      nodes.push(node(file, content, [file], 0, true));
      break;
    }
  }
  if (!canonical) throw Error('Required canonical workspace instructions are unavailable');
  for (const file of recipe.files) {
    if (file === canonical || (file === 'CLAUDE.md' && canonical === 'AGENTS.md')) continue;
    const content = await document(root, file, options.signal);
    if (content === null) throw Error(`Selected context document is unavailable: ${file}`);
    const tree = parseMarkdown(content);
    if (!tree.length) {
      if (content.trim()) nodes.push(node(file, content, [file], 0));
    } else {
      const preamble = content
        .split('\n')
        .slice(0, tree[0].line - 1)
        .join('\n');
      if (preamble.trim()) nodes.push(node(file, preamble, [file], 0));
      let index = 1;
      const visit = (heading: (typeof tree)[number], parent: string[]) => {
        const path = [...parent, heading.title];
        if (heading.content.trim()) nodes.push(node(file, heading.content, path, index++));
        heading.children.forEach((child) => visit(child, path));
      };
      tree.forEach((heading) => visit(heading, [file]));
    }
    if (nodes.length > 500) throw Error('Context documents contain too many sections');
  }
  for (const selector of recipe.excluded) {
    if (canonical && selector[0].toLowerCase() === canonical.toLowerCase())
      throw Error('A context recipe cannot exclude required workspace instructions');
  }
  options.signal?.throwIfAborted();
  const compiled = await compile({
    workspaceRoot: root,
    nodes,
    tokenBudget: recipe.tokenBudget,
    required: recipe.required,
    excluded: recipe.excluded,
  });
  options.signal?.throwIfAborted();
  const sections = (values: typeof compiled.included) =>
    values.map((section) => ({
      source: section.source.relativePath,
      heading: section.headingPath.join(' > '),
      tokens: section.tokenEstimate,
      content: section.content,
    }));
  return {
    workspaceIdentity: contextDigest(root),
    context: AgentCompiledBootContextSchema.parse({
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: compiled.sources.length,
      tokenCount: compiled.bootTokens,
      tokenBudget: recipe.tokenBudget,
      sources: compiled.sources.map((source) => ({ path: source.relativePath, kind: source.kind })),
      included: sections(compiled.included),
      trimmed: sections(compiled.trimmed),
      fullMarkdown: compiled.bootPayload,
    }),
  };
}
async function presetContext(
  recipe: Extract<AgentContextRecipe, { source: 'contexgin' }>,
  options: Options,
) {
  const base = options.contexginUrl ?? process.env.CONTEXGIN_URL ?? DEFAULT_CONTEXGIN_URL;
  const response = await (options.fetch ?? fetch)(
    `${base.replace(/\/$/, '')}/api/agents/${encodeURIComponent(recipe.agentName)}/context`,
    {
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(5000),
        ...(options.signal ? [options.signal] : []),
      ]),
    },
  );
  if (!response.ok) throw Error(`ContexGin preset compilation failed (${response.status})`);
  if (!response.body) throw Error('ContexGin preset response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1048576) throw Error('ContexGin preset response is too large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, size).toString('utf8');
  const value = z
    .object({
      agent: z.literal(recipe.agentName),
      boot: z.object({
        content: z.string().min(1).max(400000),
        tokens: z.number().int().nonnegative(),
        tokenBudget: z.number().int().positive(),
        sources: z.array(z.string().min(1).max(240)).max(500),
      }),
    })
    .parse(JSON.parse(body));
  return {
    context: AgentCompiledBootContextSchema.parse({
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: value.boot.sources.length,
      tokenCount: value.boot.tokens,
      tokenBudget: value.boot.tokenBudget,
      sources: value.boot.sources.map((path) => ({ path, kind: 'reference' })),
      included: [],
      trimmed: [],
      fullMarkdown: value.boot.content,
    }),
  };
}
export async function compileAgentContext(
  value: unknown,
  options: Options = {},
): Promise<CompiledAgentContext> {
  options.signal?.throwIfAborted();
  const recipe = AgentContextRecipeSchema.parse(value);
  const result =
    recipe.source === 'workspace'
      ? await workspaceContext(recipe, options)
      : await presetContext(recipe, options);
  options.signal?.throwIfAborted();
  return CompiledAgentContextSchema.parse({
    source: recipe.source,
    compilerRevision: AGENT_CONTEXT_COMPILER_REVISION,
    recipeHash: contextDigest(recipe),
    payloadHash: contextDigest(result.context),
    ...result,
  });
}
export async function verifyCompiledAgentContext(
  value: unknown,
  recipeValue: unknown,
  options: Options = {},
): Promise<CompiledAgentContext> {
  options.signal?.throwIfAborted();
  const recipe = AgentContextRecipeSchema.parse(recipeValue);
  const compiled = CompiledAgentContextSchema.parse(value);
  if (compiled.source !== recipe.source || compiled.recipeHash !== contextDigest(recipe))
    throw Error('Saved context recipe mismatch');
  if (compiled.compilerRevision !== AGENT_CONTEXT_COMPILER_REVISION)
    throw Error('Saved context compiler revision is unsupported');
  if (compiled.payloadHash !== contextDigest(compiled.context))
    throw Error('Saved context payload hash mismatch');
  if (recipe.source === 'workspace') {
    const root = await rootIdentity(options);
    if (compiled.workspaceIdentity !== contextDigest(root))
      throw Error('Saved context belongs to another workspace');
    // A previously public document can become operator authority after enrollment.
    // Pinned context must not replay that document through a cached payload.
    for (const reference of new Set([
      ...recipe.files,
      ...compiled.context.sources.map((source) => source.path),
    ]))
      assertAllowedDocument(root, reference);
  }
  options.signal?.throwIfAborted();
  return compiled;
}
