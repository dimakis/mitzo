import { registerAuthSession, type AuthSession } from './auth.js';

/** A run retains its admitted subject, not the lifetime of one browser connection. */
export function retainAgentContextAuthority(auth: AuthSession, controller: AbortController) {
  let invalid = false;
  let released = false;
  const unregister = registerAuthSession(auth, () => {
    invalid = true;
    controller.abort(Error('Agent context authorization expired or revoked'));
  });
  return {
    assertCurrent() {
      if (released) throw Error('Agent context authorization was released');
      controller.signal.throwIfAborted();
      if (invalid || auth.expiresAt <= Date.now())
        throw Error('Agent context authorization expired or revoked');
    },
    release() {
      if (!released) {
        released = true;
        unregister();
      }
    },
  };
}
