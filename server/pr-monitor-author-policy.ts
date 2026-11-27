import type { PrMonitorSubscription } from '@mitzo/protocol';
export type PrMonitorAuthorPolicy =
  readonly string[] | ((subscription: PrMonitorSubscription) => readonly string[]);
export function prMonitorAuthors(
  policy: PrMonitorAuthorPolicy,
  subscription: PrMonitorSubscription,
) {
  const names = typeof policy === 'function' ? policy(subscription) : policy;
  if (names.length > 50 || names.some((name) => !name || name.length > 100))
    throw Error('invalid_author_policy');
  return new Set(names.map((name) => name.toLowerCase()));
}
