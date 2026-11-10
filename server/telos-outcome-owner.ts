import { TelosCanonicalOutcomeReceiptSchema } from '@mitzo/protocol';
import { TelosRuntimeStore } from './telos-runtime-store.js';
import type { z } from 'zod';

export type CanonicalTelosOutcomeResult = {
  itemId: string;
  receipt: z.infer<typeof TelosCanonicalOutcomeReceiptSchema>;
};

/** The original approved source identity and current authority reach the same
 * canonical transaction as the outcome, milestones and recovery receipt. */
export async function createCanonicalTelosOutcome(
  options: { dbPath(): string },
  raw: unknown,
  assertCurrentSync: () => void,
): Promise<CanonicalTelosOutcomeResult> {
  const store = new TelosRuntimeStore(options.dbPath());
  try {
    const receipt = TelosCanonicalOutcomeReceiptSchema.parse(
      store.createOutcome(raw, assertCurrentSync),
    );
    return { itemId: receipt.item.id, receipt };
  } finally {
    store.close();
  }
}
