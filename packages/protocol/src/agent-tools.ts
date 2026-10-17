import { z } from 'zod';

/** Implementation contract IDs, never provider wire aliases or account-specific grants. */
const BuiltinToolReferenceSchema = z.strictObject({
  id: z.string().regex(/^mitzo:[A-Za-z][A-Za-z0-9]{0,95}$/),
  version: z.number().int().positive(),
});
/** Opaque locally verified discovery receipts; never auto-resolved by server/display name. */
export const ConfiguredToolReferenceSchema = z.strictObject({
  id: z
    .string()
    .regex(/^mcp:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  revision: z.uuid(),
});
export const ApiToolReferenceSchema = z.strictObject({
  id: z.string().regex(/^api:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  version: z.number().int().positive(),
  revision: z.uuid(),
});
export const AgentToolReferenceSchema = z.union([
  ApiToolReferenceSchema,
  BuiltinToolReferenceSchema,
  ConfiguredToolReferenceSchema,
]);
export const AgentToolReferencesSchema = z
  .array(AgentToolReferenceSchema)
  .max(100)
  .superRefine((refs, ctx) => {
    if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
      ctx.addIssue({ code: 'custom', message: 'Tool identities must be unique' });
  });
export type AgentToolReference = z.infer<typeof AgentToolReferenceSchema>;
export type AgentToolCatalogEntry = AgentToolReference & {
  name: string;
  description: string;
  source: string;
  required: boolean;
  behavior: 'read' | 'write' | 'mixed' | 'interaction';
  routes: string[];
  requirement: string;
};
