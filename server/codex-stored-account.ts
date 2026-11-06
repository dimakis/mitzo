import { z } from 'zod';
import { AccountProviderSchema, type AccountBinding } from '@mitzo/protocol';

/** Native rows omit the display label; it is never a routing authority. */
export function codexStoredAccountKey(binding: AccountBinding): string {
  return JSON.stringify([
    binding.accountId,
    binding.provider,
    binding.model,
    binding.profileRevision,
  ]);
}
export function readCodexStoredAccountKey(encoded: string) {
  const [accountId, provider, model, profileRevision] = z
    .tuple([z.string().min(1), AccountProviderSchema, z.string().min(1), z.string().min(1)])
    .parse(JSON.parse(encoded));
  return { accountId, provider, model, profileRevision };
}
