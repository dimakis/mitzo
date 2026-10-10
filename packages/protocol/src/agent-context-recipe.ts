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
