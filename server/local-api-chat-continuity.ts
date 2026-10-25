import { isDeepStrictEqual } from 'node:util';
import { SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import type { OrdinarySessionRuntimeResolution } from './ordinary-session-runtime.js';

/** Called only with a retained server-owned binding. Native admission still
 * verifies original login, credential custody, history and workspace. The
 * current configuration resolver checks every field except the old deployment
 * fingerprint; no new work or client request may choose that fingerprint.
 */
export function retainLocalApiChatBinding(
  current: OrdinarySessionRuntimeResolution,
  retained?: unknown,
): OrdinarySessionRuntimeResolution {
  if (retained === undefined || current.status !== 'compatible') return current;
  const parsed = SessionRuntimeBindingV2Schema.safeParse(retained);
  if (
    !parsed.success ||
    parsed.data.execution.location !== 'local' ||
    !['claude-sdk', 'gemini'].includes(parsed.data.harness.implementation) ||
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
