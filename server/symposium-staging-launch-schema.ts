import { isAbsolute } from 'node:path';
import { z } from 'zod';
/** Static registration contract; importing it creates no registry or native owner. */
export const StagingLaunchSchema = z.strictObject({
  registryDirectory: z.string().refine(isAbsolute),
  capacity: z.number().int().min(1).max(20),
  ownerChat: z.string(),
  purpose: z.string(),
  retentionReason: z.string(),
  reviewAfter: z.number().int().positive(),
});
