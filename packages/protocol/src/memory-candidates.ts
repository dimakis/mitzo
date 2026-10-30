import { z } from 'zod';

export const MemoryCandidateSchema = z.strictObject({
  requestId: z.uuid(),
  summary: z.string().trim().min(1).max(4000),
  quotes: z.array(z.string().trim().min(1).max(4000)).min(1).max(8),
});
