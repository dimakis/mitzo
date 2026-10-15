import { z } from 'zod';

/** Implementation contract IDs, never provider wire aliases or account-specific grants. */
export const AgentToolReferenceSchema = z.strictObject({
  id: z.string().regex(/^mitzo:[A-Za-z][A-Za-z0-9]{0,95}$/),
  version: z.number().int().positive(),
});
export const AgentToolReferencesSchema = z
  .array(AgentToolReferenceSchema)
  .max(100)
  .superRefine((refs, ctx) => {
    if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
      ctx.addIssue({ code: 'custom', message: 'Tool identities must be unique' });
  });
export type AgentToolReference = z.infer<typeof AgentToolReferenceSchema>;
export interface AgentToolCatalogEntry extends AgentToolReference {
  name: string;
  description: string;
  source: string;
  required: boolean;
  behavior: 'read' | 'write' | 'mixed' | 'interaction';
  routes: string[];
  requirement: string;
}
