import { z } from 'zod';
import { ContextPackPinSchema } from './agent-context-pack.js';

const documentReference = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?:[a-zA-Z0-9_. -]+\/)*[a-zA-Z0-9_. -]+\.(?:md|mdc)$/)
  .refine(
    (value) =>
      value
        .split('/')
        .every(
          (part, index) =>
            part !== '.' &&
            part !== '..' &&
            (!part.startsWith('.') ||
              (index === 0 && part === '.cursor' && value.startsWith('.cursor/rules/'))),
        ),
    'Use a relative Markdown document reference',
  );
const selectors = z.array(z.array(z.string().trim().min(1).max(120)).min(1).max(8)).max(20);

export const WorkspaceAgentContextRecipeSchema = z.strictObject({
  version: z.literal(1),
  source: z.literal('workspace'),
  files: z
    .array(documentReference)
    .max(20)
    .refine((files) => new Set(files).size === files.length, 'Duplicate context documents'),
  tokenBudget: z.number().int().min(256).max(32000),
  required: selectors,
  excluded: selectors,
});
export type WorkspaceAgentContextRecipe = z.infer<typeof WorkspaceAgentContextRecipeSchema>;

/** Compilation inputs only. Workspace ownership and runtime admission stay with the host. */
export const AgentContextRecipeSchema = z.discriminatedUnion('source', [
  z.strictObject({
    version: z.literal(2),
    source: z.literal('packs'),
    packs: z
      .array(ContextPackPinSchema)
      .min(1)
      .max(20)
      .refine(
        (packs) => new Set(packs.map((pack) => pack.id)).size === packs.length,
        'A pack may appear only once in a composition',
      ),
    tokenBudget: z.number().int().min(256).max(32000),
  }),
  WorkspaceAgentContextRecipeSchema,
  z.strictObject({
    version: z.literal(1),
    source: z.literal('contexgin'),
    agentName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  }),
]);
export type AgentContextRecipe = z.infer<typeof AgentContextRecipeSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const section = z.strictObject({
  source: z.string().max(240),
  heading: z.string().max(1000),
  tokens: z.number().int().nonnegative().max(100000),
  content: z.string().max(262144),
});
export const AgentCompiledBootContextSchema = z
  .strictObject({
    type: z.literal('boot_context'),
    source: z.literal('contexgin'),
    sourceCount: z.number().int().nonnegative().max(500),
    tokenCount: z.number().int().positive().max(100000),
    tokenBudget: z.number().int().positive().max(100000),
    sources: z
      .array(z.strictObject({ path: z.string().min(1).max(240), kind: z.string().min(1).max(40) }))
      .max(500),
    included: z.array(section).max(500),
    trimmed: z.array(section).max(500),
    fullMarkdown: z
      .string()
      .min(1)
      .max(400000)
      .refine((value) => value.trim().length > 0, 'Compiled context is empty'),
  })
  .superRefine((context, ctx) => {
    if (context.sourceCount !== context.sources.length || context.tokenCount > context.tokenBudget)
      ctx.addIssue({ code: 'custom', message: 'Invalid compiled context counts or budget' });
  });
export const CompiledAgentContextSchema = z
  .strictObject({
    source: z.enum(['workspace', 'contexgin', 'packs']),
    provenance: z
      .strictObject({
        packs: z.array(ContextPackPinSchema).min(1).max(20),
        documents: z
          .array(
            z.strictObject({
              storeId: z.string().min(1).max(128),
              path: z.string().min(1).max(240),
              revision: z.string().regex(/^[a-f0-9]{40,64}$/),
              contentHash: digest,
            }),
          )
          .max(500),
        omissions: z
          .array(
            z.strictObject({
              path: z.string().min(1).max(240),
              heading: z.string().max(1000),
              reason: z.enum(['excluded', 'budget']),
            }),
          )
          .max(500),
      })
      .optional(),
    compilerRevision: z.string().min(1).max(128),
    recipeHash: digest,
    payloadHash: digest,
    workspaceIdentity: digest.optional(),
    context: AgentCompiledBootContextSchema,
  })
  .superRefine((compiled, ctx) => {
    if ((compiled.source === 'packs') !== (compiled.provenance !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Compiled pack provenance mismatch' });
    if ((compiled.source === 'workspace') !== (compiled.workspaceIdentity !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Compiled context workspace identity mismatch' });
  });
export type CompiledAgentContext = z.infer<typeof CompiledAgentContextSchema>;

/** Conversation-owned receipt; excluded from portable Library definitions and exports. */
export const AgentSandboxContextScopeSchema = z.strictObject({
  sandboxId: z.string().min(1).max(200),
  sandboxName: z.string().min(1).max(200),
  workspaceRoot: z
    .string()
    .min(1)
    .max(1000)
    .regex(/^\/sandbox\/workspaces\//)
    .refine((value) =>
      value
        .split('/')
        .slice(1)
        .every((part) => !!part && part !== '.' && part !== '..'),
    ),
  runtimeContractImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  compilerSha256: digest,
  entrypointSha256: digest,
  recipeSha256: digest,
  runtimeInputsSha256: digest,
});
export type AgentSandboxContextScope = z.infer<typeof AgentSandboxContextScopeSchema>;
export const AgentContextSnapshotSchema = CompiledAgentContextSchema.safeExtend({
  profileId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  profileHash: digest,
  sandbox: AgentSandboxContextScopeSchema.safeExtend({ effectiveRecipeHash: digest }).optional(),
});
export type AgentContextSnapshot = z.infer<typeof AgentContextSnapshotSchema>;

/** Display/delivery metadata lives outside the immutable compiled payload. */
export const AgentContextReceiptSchema = z.strictObject({
  recipeHash: digest,
  compilerRevision: z.string().min(1).max(128),
  payloadHash: digest,
  provenance: CompiledAgentContextSchema.shape.provenance,
  status: z.enum(['prepared', 'accepted']),
  profileId: z.string().trim().min(1).max(128),
  profileRevision: z.number().int().positive(),
});
export type AgentContextReceipt = z.infer<typeof AgentContextReceiptSchema>;
