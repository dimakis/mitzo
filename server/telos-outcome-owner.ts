import { existsSync } from 'node:fs';
import { z } from 'zod';
import { TelosOutcomeCreateBodySchema, TelosCanonicalOutcomeReceiptSchema } from '@mitzo/protocol';
import { TelosWorkError } from './telos-work-store.js';

const CanonicalOutcomeReceiptSchema = TelosCanonicalOutcomeReceiptSchema;
export type CanonicalTelosOutcomeResult = {
  itemId: string;
  receipt: z.infer<typeof CanonicalOutcomeReceiptSchema>;
};

/** Transport to the existing canonical creator. It alone creates the item and
 * milestones. Callers supply its selected database environment and stable key;
 * there is no fallback store, session allocator or model invocation here.
 */
export async function createCanonicalTelosOutcome(
  options: {
    script: string;
    exists?(path: string): boolean;
    timeoutMs: number;
    maxBufferBytes: number;
    execute(
      command: string,
      args: string[],
      options: { timeout: number; maxBuffer: number; encoding: 'utf8' },
    ): Promise<{ stdout: string }>;
  },
  raw: unknown,
  assertCurrentSync?: () => void,
): Promise<CanonicalTelosOutcomeResult> {
  const input = TelosOutcomeCreateBodySchema.parse(raw);
  if (!(options.exists ?? existsSync)(options.script))
    throw Error('Canonical Telos creator unavailable');
  // Renew the original pending native/UI source authority at the actual
  // external creator dispatch. No await separates admission from execution.
  if (assertCurrentSync) {
    const result: unknown = assertCurrentSync();
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw Error('Canonical Telos source authority unavailable');
    }
  }
  let stdout: string;
  try {
    ({ stdout } = await options.execute(
      'python3',
      [options.script, '--create-outcome-json', JSON.stringify(input)],
      { timeout: options.timeoutMs, maxBuffer: options.maxBufferBytes, encoding: 'utf8' },
    ));
  } catch {
    throw Error('Canonical Telos creator unavailable');
  }
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw Error('Invalid canonical Telos reply');
  }
  const parsed = CanonicalOutcomeReceiptSchema.safeParse(result);
  if (!parsed.success) {
    const failure = z
      .object({ ok: z.literal(false), error: z.string().max(4000) })
      .safeParse(result);
    if (failure.success && failure.data.error.startsWith('profile must be one of:'))
      throw new TelosWorkError('invalid', failure.data.error);
    throw new TelosWorkError('invalid', 'Canonical Telos rejected the reviewed outcome');
  }
  return { itemId: parsed.data.item.id, receipt: parsed.data };
}
