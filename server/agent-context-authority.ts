import { registerAuthSession, type AuthSession } from './auth.js';
import { SessionRuntimeError, findSessionRuntimeError } from './session-runtime-error.js';

/** Retain only host-classified authentication loss, never arbitrary assertion text. */
export function agentContextAuthenticationFailure(
  reason: unknown,
): SessionRuntimeError | undefined {
  const failure = findSessionRuntimeError(reason);
  return failure?.code === 'auth_expired' || failure?.code === 'auth_revoked' ? failure : undefined;
}

export function agentContextRuntimeError(
  error: Error,
  assertCurrent?: () => void,
  retainedReason?: unknown,
): Error {
  const retained = agentContextAuthenticationFailure(retainedReason);
  if (retained) return retained;
  try {
    assertCurrent?.();
  } catch (cause) {
    const failure = agentContextAuthenticationFailure(cause);
    if (failure) return failure;
  }
  return error;
}

/** A run retains its admitted subject, not the lifetime of one browser connection. */
export function retainAgentContextAuthority(auth: AuthSession, controller: AbortController) {
  let invalidation: SessionRuntimeError | undefined;
  let released = false;
  const unregister = registerAuthSession(auth, (reason) => {
    invalidation ??= new SessionRuntimeError(
      reason === 'expired' ? 'auth_expired' : 'auth_revoked',
    );
    controller.abort(invalidation);
  });
  return {
    /** Diagnostic-only observation survives release and does not grant authority. */
    failure: () => invalidation,
    assertCurrent() {
      if (released) throw Error('Agent context authorization was released');
      controller.signal.throwIfAborted();
      if (invalidation || auth.expiresAt <= Date.now())
        throw (invalidation ??= new SessionRuntimeError('auth_expired'));
    },
    release() {
      if (!released) {
        released = true;
        unregister();
      }
    },
  };
}
