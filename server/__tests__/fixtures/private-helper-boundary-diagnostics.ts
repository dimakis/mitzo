import { preparationDiagnosticFailure } from './preparation-attempt-diagnostics.js';

type Owner = {
  timeoutMs: number;
  deadline?: number;
  signal: AbortSignal;
  assertCurrentSync(): void;
  revalidate(): Promise<void>;
};
/** Fixture-only observation: retain the exact options object, callback receiver,
 * return values, promises and errors. No authority check is added or omitted. */
export async function observePrivateHelperBoundary<T extends Owner, R>(
  input: T,
  run: (input: T) => Promise<R>,
  rows: unknown[],
  clock = Date.now,
): Promise<R> {
  const started = clock();
  const deadline = Math.min(started + input.timeoutMs, input.deadline ?? Infinity);
  const row = {
    timeoutMs: input.timeoutMs,
    startedAt: started,
    elapsedMs: 0,
    remainingMs: deadline - started,
    aborted: input.signal.aborted,
    status: 'running',
    error: undefined as ReturnType<typeof preparationDiagnosticFailure> | undefined,
    gates: [] as Array<Record<string, unknown>>,
  };
  rows.push(row);
  const descriptors = ['assertCurrentSync', 'revalidate'].map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(input, key)!,
  }));
  for (const { key, descriptor } of descriptors) {
    Object.defineProperty(input, key, {
      ...descriptor,
      value: function (...args: unknown[]) {
        const begin = clock();
        const gate: Record<string, unknown> = {
          kind: key === 'revalidate' ? 'async' : 'sync',
          startedMs: begin - started,
        };
        if (row.gates.length < 128) row.gates.push(gate);
        const finish = (status: string, error?: unknown) => {
          gate.elapsedMs = clock() - begin;
          gate.remainingMs = deadline - clock();
          gate.aborted = input.signal.aborted;
          gate.status = status;
          if (error !== undefined) gate.error = preparationDiagnosticFailure(error);
        };
        try {
          const result: unknown = Reflect.apply(descriptor.value, input, args);
          if (result instanceof Promise)
            void result.then(
              () => finish('returned'),
              (error) => finish('rejected', error),
            );
          else finish('returned');
          return result;
        } catch (error) {
          finish('rejected', error);
          throw error;
        }
      },
    });
  }
  try {
    const result = await run(input);
    row.status = 'returned';
    return result;
  } catch (error) {
    row.status = 'rejected';
    row.error = preparationDiagnosticFailure(error);
    throw error;
  } finally {
    row.elapsedMs = clock() - started;
    row.remainingMs = deadline - clock();
    row.aborted = input.signal.aborted;
    for (const { key, descriptor } of descriptors) Object.defineProperty(input, key, descriptor);
  }
}
