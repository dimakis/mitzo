import { z } from 'zod';
import { SymposiumProfileDefinitionSchema, SymposiumProfileRecipeSchema } from './symposium.js';

/** Raw known editor fields preserve incomplete drafts. Publication validates separately. */
const recipe = SymposiumProfileRecipeSchema.extend({
  skillRefs: z.array(z.string()),
  toolDefaults: SymposiumProfileRecipeSchema.shape.toolDefaults.extend({
    preferredTools: z.array(z.string()),
  }),
  compatibleProviders: SymposiumProfileRecipeSchema.shape.compatibleProviders.unwrap().array(),
});
export const AgentLibraryEditableDefinitionSchema = SymposiumProfileDefinitionSchema.extend({
  name: z.string(),
  descriptor: z.string().optional(),
  description: z.string().optional(),
  role: z.string(),
  instructions: z.string(),
  expectedOutput: z.string(),
  acceptanceCriteria: z.array(z.string()),
  modelPolicyRole: z.string(),
  recipe: recipe.optional(),
  contextRecipe: z
    .discriminatedUnion('source', [
      z.strictObject({
        version: z.literal(1),
        source: z.literal('workspace'),
        files: z.array(z.string()),
        tokenBudget: z.number(),
        required: z.array(z.array(z.string())),
        excluded: z.array(z.array(z.string())),
      }),
      z.strictObject({
        version: z.literal(2),
        source: z.literal('packs'),
        packs: z.array(z.strictObject({ id: z.string(), revision: z.number(), hash: z.string() })),
        tokenBudget: z.number(),
      }),
      z.strictObject({
        version: z.literal(1),
        source: z.literal('contexgin'),
        agentName: z.string(),
      }),
    ])
    .optional(),
});
