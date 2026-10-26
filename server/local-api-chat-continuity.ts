import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import type { OrdinarySessionRuntimeResolution } from './ordinary-session-runtime.js';

const reviewedLegacyContracts = {
  'claude-sdk': {
    '86916da4af1c2e17fdbe9132543afaa3dadec88b':
      'ee64395c460a8366282b8cf92d7f28dcf22df2526efac2239192c91d0f74dd7c',
    c42ce72a2c84e94bac1b14ecba3585789f320264:
      'd653db8d6727aee2a2ac983103d2166dfdfcc8d1da625e58f5d7b77fe8343a2f',
    '263cfea8bb65e48801b88fdd1b45fd3256f1b2ee':
      'bb55cd5e91a9712c68a16886cecd4ffa3eeb44dbf5a0dc7909750be8a46a5e69',
  },
  gemini: {
    '86916da4af1c2e17fdbe9132543afaa3dadec88b':
      '4745665b0ee5eb29e5a4187f8205834149986054b4b6522dbaf2605b37d715e0',
  },
} as const;

/** Exact v1 source contracts from the accepted releases recorded above.
 * Reconstructing that exact declaration proves the original host and protocol;
 * native credential/history/workspace custody is still required by admission.
 * Unknown releases and another host's stable v2 revision are never aliases.
 */
export function reviewedLegacyLocalApiTargetRevisions(
  harness: 'claude-sdk' | 'gemini' | 'responses',
  current: { targetId: string; targetRevision: string; label: string; hostId: string },
): readonly string[] {
  if (harness === 'responses') return [];
  const currentProtocol = createHash('sha256')
    .update(
      JSON.stringify([
        `ordinary-local-${harness === 'claude-sdk' ? 'vertex' : harness}-target-v2`,
        current.targetId,
        current.hostId,
        `${harness}-session-v1`,
      ]),
    )
    .digest('hex');
  if (current.targetRevision !== currentProtocol) return [];
  return Object.values(reviewedLegacyContracts[harness]).map((contract) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          `ordinary-local-${harness === 'claude-sdk' ? 'vertex' : harness}-target-v1`,
          {
            version: 1,
            targetId: current.targetId,
            label: current.label,
            hostId: current.hostId,
            runtimeContractRevision: contract,
          },
        ]),
      )
      .digest('hex'),
  );
}

export function retainedLocalApiTargetRevision(
  current: string,
  retained: unknown,
  reviewedLegacy: readonly string[],
): string {
  if (retained === undefined) return current;
  const revision = SessionRuntimeBindingV2Schema.parse(retained).execution.targetRevision;
  if (revision !== current && !reviewedLegacy.includes(revision))
    throw Error('Original local host or protocol identity is unavailable');
  return revision;
}

/** Called only with a retained server-owned binding. Native admission still
 * verifies original login, credential custody, history and workspace. The
 * current configuration resolver checks every field. Only the reviewed legacy
 * declaration above may replace an old deployment fingerprint.
 */
export function retainLocalApiChatBinding(
  current: OrdinarySessionRuntimeResolution,
  retained?: unknown,
  reviewedLegacy: readonly string[] = [],
): OrdinarySessionRuntimeResolution {
  if (retained === undefined || current.status !== 'compatible') return current;
  const parsed = SessionRuntimeBindingV2Schema.safeParse(retained);
  if (
    !parsed.success ||
    parsed.data.execution.location !== 'local' ||
    !['claude-sdk', 'gemini'].includes(parsed.data.harness.implementation) ||
    (parsed.data.execution.targetRevision !== current.binding.execution.targetRevision &&
      !reviewedLegacy.includes(parsed.data.execution.targetRevision)) ||
    !isDeepStrictEqual(
      {
        ...current.binding,
        execution: {
          ...current.binding.execution,
          targetRevision: parsed.data.execution.targetRevision,
        },
      },
      parsed.data,
    )
  )
    return { status: 'rejected', code: 'unsupported_tuple' };
  return { status: 'compatible', binding: parsed.data };
}
