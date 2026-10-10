import { z } from 'zod';

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

/** Compilation inputs only. Workspace ownership and runtime admission stay with the host. */
export const AgentContextRecipeSchema = z.discriminatedUnion('source', [
  z.strictObject({
    version: z.literal(1),
    source: z.literal('workspace'),
    files: z
      .array(documentReference)
      .max(20)
      .refine((files) => new Set(files).size === files.length, 'Duplicate context documents'),
    tokenBudget: z.number().int().min(256).max(32000),
    required: selectors,
    excluded: selectors,
  }),
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
    tokenCount: z.number().int().nonnegative().max(100000),
    tokenBudget: z.number().int().positive().max(100000),
    sources: z
      .array(z.strictObject({ path: z.string().min(1).max(240), kind: z.string().min(1).max(40) }))
      .max(500),
    included: z.array(section).max(500),
    trimmed: z.array(section).max(500),
    fullMarkdown: z.string().min(1).max(400000),
  })
  .superRefine((context, ctx) => {
    if (context.sourceCount !== context.sources.length || context.tokenCount > context.tokenBudget)
      ctx.addIssue({ code: 'custom', message: 'Invalid compiled context counts or budget' });
  });
export const CompiledAgentContextSchema = z
  .strictObject({
    source: z.enum(['workspace', 'contexgin']),
    compilerRevision: z.string().min(1).max(128),
    recipeHash: digest,
    payloadHash: digest,
    workspaceIdentity: digest.optional(),
    context: AgentCompiledBootContextSchema,
  })
  .superRefine((compiled, ctx) => {
    if ((compiled.source === 'workspace') !== (compiled.workspaceIdentity !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Compiled context workspace identity mismatch' });
  });
export type CompiledAgentContext = z.infer<typeof CompiledAgentContextSchema>;

/** Conversation-owned receipt; excluded from portable Library definitions and exports. */
export const AgentContextSnapshotSchema = CompiledAgentContextSchema.safeExtend({
  profileId: z.string().trim().min(1).max(128),
  revision: z.number().int().positive(),
  profileHash: digest,
});
export type AgentContextSnapshot = z.infer<typeof AgentContextSnapshotSchema>;
