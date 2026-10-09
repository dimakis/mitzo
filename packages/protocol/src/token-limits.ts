import { z } from 'zod';

const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Capacity evidence is display metadata, never provider admission or budget enforcement. */
export const ModelTokenLimitsSchema = z.object({
  model: z.string().min(1).max(256),
  source: z.enum(['runtime', 'provider', 'catalog', 'unknown']),
  sourceName: z.string().min(1).max(80).optional(),
  contextWindow: limit.optional(),
  inputTokenLimit: limit.optional(),
  outputTokenLimit: limit.optional(),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  stale: z.boolean().default(false),
});
export type ModelTokenLimits = z.infer<typeof ModelTokenLimitsSchema>;
