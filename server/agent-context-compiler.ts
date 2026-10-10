import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as contexgin from 'contexgin';
import { compileWorkspaceContext } from '../scripts/agent-workspace-context.mjs';
import {
  AgentContextRecipeSchema,
  AgentCompiledBootContextSchema,
  CompiledAgentContextSchema,
  type AgentContextRecipe,
  type CompiledAgentContext,
} from '@mitzo/protocol';
import { z } from 'zod';
import { compileContextPacks, type AuthorizedContextPacks } from './agent-context-pack-compiler.js';
export type { AuthorizedContextPacks } from './agent-context-pack-compiler.js';
import { DEFAULT_CONTEXGIN_URL } from './constants.js';

// Pinned dependency plus this preloaded-document compiler contract; never a runtime grant.
export const AGENT_CONTEXT_COMPILER_REVISION =
  'mitzo-context-v3:contexgin-683f9007db686e710ed9a5410468fe33df1c5382';
export const AGENT_PACK_CONTEXT_COMPILER_REVISION =
  'mitzo-context-packs-v1:contexgin-683f9007db686e710ed9a5410468fe33df1c5382';
export const contextDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type AgentContextCompileOptions = {
  packs?: AuthorizedContextPacks;
  workspaceRoot?: string;
  contexginUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

async function rootIdentity(options: AgentContextCompileOptions) {
  if (!options.workspaceRoot) throw Error('Select a chat workspace for context compilation');
  return realpath(options.workspaceRoot);
}

async function presetContext(
  recipe: Extract<AgentContextRecipe, { source: 'contexgin' }>,
  options: AgentContextCompileOptions,
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
  options: AgentContextCompileOptions = {},
): Promise<CompiledAgentContext> {
  options.signal?.throwIfAborted();
  const recipe = AgentContextRecipeSchema.parse(value);
  const result =
    recipe.source === 'workspace'
      ? await compileWorkspaceContext(recipe, options, contexgin)
      : recipe.source === 'packs'
        ? await compileContextPacks(recipe, options.packs, options.signal)
        : await presetContext(recipe, options);
  options.signal?.throwIfAborted();
  return CompiledAgentContextSchema.parse({
    source: recipe.source,
    compilerRevision:
      recipe.source === 'packs'
        ? AGENT_PACK_CONTEXT_COMPILER_REVISION
        : AGENT_CONTEXT_COMPILER_REVISION,
    recipeHash: contextDigest(recipe),
    payloadHash: contextDigest(
      'provenance' in result
        ? { context: result.context, provenance: result.provenance }
        : result.context,
    ),
    ...result,
  });
}
export async function verifyCompiledAgentContext(
  value: unknown,
  recipeValue: unknown,
  options: AgentContextCompileOptions = {},
): Promise<CompiledAgentContext> {
  options.signal?.throwIfAborted();
  const recipe = AgentContextRecipeSchema.parse(recipeValue);
  const compiled = CompiledAgentContextSchema.parse(value);
  if (compiled.source !== recipe.source || compiled.recipeHash !== contextDigest(recipe))
    throw Error('Saved context recipe mismatch');
  if (
    recipe.source === 'packs' &&
    contextDigest(compiled.provenance?.packs) !== contextDigest(recipe.packs)
  )
    throw Error('Saved context pack provenance mismatch');
  if (
    compiled.compilerRevision !==
    (recipe.source === 'packs'
      ? AGENT_PACK_CONTEXT_COMPILER_REVISION
      : AGENT_CONTEXT_COMPILER_REVISION)
  )
    throw Error('Saved context compiler revision is unsupported');
  if (
    compiled.payloadHash !==
    contextDigest(
      compiled.provenance
        ? { context: compiled.context, provenance: compiled.provenance }
        : compiled.context,
    )
  )
    throw Error('Saved context payload hash mismatch');
  if (recipe.source === 'packs') {
    const packs = options.packs;
    if (!packs?.sourceIdentity)
      throw Error('Runtime source authorization is required for retained context packs');
    packs.assertCurrent();
    for (const document of compiled.provenance!.documents) {
      if (document.storeId !== packs.sourceIdentity)
        throw Error('Saved context source namespace identity mismatch');
      await packs.authorize(
        { ...document, mode: 'required', headings: [], priority: 100 },
        options.signal,
      );
      options.signal?.throwIfAborted();
      packs.assertCurrent();
    }
  }
  if (
    recipe.source === 'workspace' &&
    compiled.workspaceIdentity !== contextDigest(await rootIdentity(options))
  )
    throw Error('Saved context belongs to another workspace');
  options.signal?.throwIfAborted();
  return compiled;
}
