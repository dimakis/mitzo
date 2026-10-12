import type { SymposiumSharedSandboxOwnerDeps } from './symposium-session-runtime.js';

type Manager = ReturnType<NonNullable<SymposiumSharedSandboxOwnerDeps['managerFactory']>>;

/** Wrap only the actual retained manager; the original source-only queue
 * capability runs on every effect boundary, never a cached allow decision. */
export function guardStagingNativeRuntimeEffects(
  manager: Manager,
  assertCurrent: () => void,
): Manager {
  const guard =
    <A extends unknown[], R>(method: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      assertCurrent();
      const result = await method.apply(manager, args);
      assertCurrent();
      return result;
    };
  return Object.freeze({
    ensure: guard(manager.ensure),
    ...(manager.inspect ? { inspect: guard(manager.inspect) } : {}),
    ...(manager.inspectReserved ? { inspectReserved: guard(manager.inspectReserved) } : {}),
    ...(manager.stop ? { stop: guard(manager.stop) } : {}),
    ...(manager.delete ? { delete: guard(manager.delete) } : {}),
  });
}
