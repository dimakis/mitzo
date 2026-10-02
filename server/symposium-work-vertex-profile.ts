import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const SymposiumWorkVertexProfile = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1).max(256),
  provider: z.literal('anthropic-vertex'),
  credentialRef: z.string().refine(isAbsolute),
  expectedPrincipal: z.email().max(254),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  region: z.literal('global'),
  models: z
    .array(z.strictObject({ id: z.literal('claude-haiku-4-5@20251001'), label: z.string().min(1) }))
    .length(1),
});
