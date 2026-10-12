const refuse = () =>
  Error('Original native owner handoff unavailable; no new start or authority replay');
/** Trusted same-process fencing only. This closure neither mints capacity nor
 * establishes provider/model approval; the original new guard invokes handoff
 * only after complete fresh native proof and before releasing that guard. */
export function createNativeOriginalOwnerHandoff({
  assertRegisteredOriginal,
  assertInitialGuard,
  assertInitialAuthentication,
}) {
  if (
    [assertRegisteredOriginal, assertInitialGuard, assertInitialAuthentication].some(
      (fn) => typeof fn !== 'function',
    )
  )
    throw refuse();
  let originalCurrent,
    retirementAttempted = false;
  const sync = (fn) => {
    const result = fn();
    if (result instanceof Promise) {
      void result.catch(() => {});
      throw refuse();
    }
    if (result === false) throw refuse();
  };
  const original = () => {
    sync(assertRegisteredOriginal);
    if (originalCurrent) sync(originalCurrent);
    else {
      sync(assertInitialGuard);
      sync(assertInitialAuthentication);
    }
  };
  return Object.freeze({
    assertCurrent: original,
    assertFreshStartCurrent() {
      if (originalCurrent) throw refuse();
      original();
    },
    handoff(current) {
      if (originalCurrent || typeof current !== 'function') throw refuse();
      original();
      sync(current);
      originalCurrent = current;
      original();
    },
    hasOriginalOwner() {
      return Boolean(originalCurrent);
    },
    /** Source-owned custodian invokes this after actual host close. The app IPC
     * lifetime has ended; the original custodian supplies its separate bounded
     * retirement lifetime. The independent registered parent fence stays live.
     * This never reopens a stopped owner or grants another start. */
    async retire(assertRetirementCurrent, cleanup) {
      if (
        !originalCurrent ||
        retirementAttempted ||
        typeof assertRetirementCurrent !== 'function' ||
        typeof cleanup !== 'function'
      )
        throw refuse();
      sync(assertRegisteredOriginal);
      sync(assertRetirementCurrent);
      retirementAttempted = true;
      originalCurrent = assertRetirementCurrent;
      try {
        original();
        await cleanup();
        original();
      } finally {
        originalCurrent = () => {
          throw refuse();
        };
      }
    },
  });
}
