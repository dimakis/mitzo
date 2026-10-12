/** The actual original constructor supplies its real host custody assertion.
 * This lifetime survives child-only quiescence, never custodian/host replacement.
 * It does not admit a launch, allocate capacity or restore a serialized owner. */
export function createOriginalCustodianLifetime(input: {
  instanceId: string;
  assertHostCurrent(): unknown;
}) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.instanceId) ||
    typeof input.assertHostCurrent !== 'function'
  )
    throw Error('Actual original custodian lifetime required');
  const pid = process.pid;
  let closed = false;
  const assertCurrent = () => {
    if (closed || process.pid !== pid)
      throw Error('Original retained custodian lifetime unavailable');
    let result: unknown;
    try {
      result = input.assertHostCurrent();
    } catch (error) {
      closed = true;
      throw error;
    }
    if (result instanceof Promise) {
      closed = true;
      void result.catch(() => {});
      throw Error('Original host custody assertion must be synchronous');
    }
    if (result === false) {
      closed = true;
      throw Error('Original retained host custody unavailable');
    }
    if (closed || process.pid !== pid)
      throw Error('Original retained custodian lifetime unavailable');
  };
  assertCurrent();
  return Object.freeze({
    identity: Object.freeze({ instanceId: input.instanceId, custodianPid: pid }),
    assertCurrent,
    close() {
      closed = true;
    },
  });
}
