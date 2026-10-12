import type { SymposiumSharedSandboxOwnerDeps } from './symposium-session-runtime.js';

type Manager = ReturnType<NonNullable<SymposiumSharedSandboxOwnerDeps['managerFactory']>>;

/** Wrap only the actual retained manager; the original source-only queue
 * capability runs on every effect boundary, never a cached allow decision. */
export function guardStagingNativeRuntimeEffects(
  manager: Manager,
  assertCurrent: () => void,
  assertCleanupCurrent: () => void = assertCurrent,
): Manager {
  const guard =
    <A extends unknown[], R>(method: (...args: A) => Promise<R>, current = assertCurrent) =>
    async (...args: A): Promise<R> => {
      current();
      const result = await method.apply(manager, args);
      current();
      return result;
    };
  return Object.freeze({
    ensure: guard(manager.ensure),
    ...(manager.inspect ? { inspect: guard(manager.inspect, assertCleanupCurrent) } : {}),
    ...(manager.inspectReserved
      ? { inspectReserved: guard(manager.inspectReserved, assertCleanupCurrent) }
      : {}),
    ...(manager.stop ? { stop: guard(manager.stop, assertCleanupCurrent) } : {}),
    ...(manager.delete ? { delete: guard(manager.delete, assertCleanupCurrent) } : {}),
  });
}
