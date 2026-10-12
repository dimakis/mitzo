import { z } from 'zod';

/** Pure scope metadata; only an authenticated original issuer can attest it. */
export const StagingApiBillingScopeSchema = z.strictObject({
  organizationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
});
