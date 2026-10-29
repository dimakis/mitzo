import { CodexToolFailure } from './codex-tool-failure.js';
import { captureLocalRepositoryPreparationObjectData } from './local-repository-preparation-object-data.js';
import { captureLocalRepositoryPreparationAuthorization } from './local-repository-preparation-authorization.js';

export interface LocalRepositoryPreparationEnvelope {
  readonly signal: AbortSignal;
  readonly deadline: number;
  assertCurrentSync(): void;
  stageDeadline(): number;
}
const totalPrepareMs = 300000;
class PreparationDeadlineError extends CodexToolFailure {
  constructor() {
    super('internal_failure', {
      stage: 'repository_preparation',
      reason: 'deadline',
      effectStatus: 'unknown',
    });
    // Fixed compatibility copy; the structured diagnostic owns classification.
    this.message = 'Preparation deadline exceeded';
  }
}

/** PRIVATE pending-callback bound. Native captures its genuine context INSIDE
 * action with this signal; the context retains its stricter original composite.
 * Expiry aborts work, but never returns before the actual action/cleanup joins. */
export async function withLocalRepositoryPreparationEnvelope<T>(
  originalSignal: AbortSignal,
  action: (envelope: Readonly<LocalRepositoryPreparationEnvelope>) => Promise<T>,
): Promise<T> {
  originalSignal.throwIfAborted();
  const deadline = Date.now() + totalPrepareMs;
  const controller = new AbortController();
  const abort = () => controller.abort(originalSignal.reason);
  originalSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new PreparationDeadlineError()), totalPrepareMs);
  const current = Object.freeze(() => {
    originalSignal.throwIfAborted();
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new PreparationDeadlineError();
  });
  const envelope = Object.freeze({
    signal: controller.signal,
    deadline,
    assertCurrentSync: current,
    stageDeadline: Object.freeze(() => {
      current();
      return Math.min(deadline, Date.now() + 30000);
    }),
  });
  try {
    current();
    const result = await action(envelope);
    current();
    return result;
  } finally {
    clearTimeout(timer);
    originalSignal.removeEventListener('abort', abort);
    controller.abort(Error('Preparation callback closed'));
  }
}

export type LocalRepositoryPreparationOwners = Parameters<
  typeof captureLocalRepositoryPreparationAuthorization
>[0];

/** Actual private operation composition, still unregistered. The native caller
 * owns genuine context capture/disposal inside the envelope's pending action. */
export async function executeLocalRepositoryPreparation(
  owners: LocalRepositoryPreparationOwners,
  rawInput: unknown,
  envelope: Readonly<LocalRepositoryPreparationEnvelope>,
) {
  const context = owners.context;
  const full = context.assertCurrent;
  const originalFull = async () => {
    const pending: unknown = Reflect.apply(full, context, []);
    if (!(pending instanceof Promise) || (await pending) !== undefined)
      throw Error('Original preparation owner unavailable');
  };
  const qualify = owners.qualifySource;
  if (typeof qualify !== 'function') throw Error('Original source qualifier unavailable');
  const sync = context.assertCurrentSync;
  const current = () => {
    context.signal.throwIfAborted();
    envelope.assertCurrentSync();
    const result: unknown = Reflect.apply(sync, context, []);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw Error('Original preparation owner unavailable');
    }
  };
  current();
  const held = await captureLocalRepositoryPreparationAuthorization(
    {
      ...owners,
      qualifySource: (path, original, intent) =>
        Reflect.apply(qualify, owners, [
          path,
          original,
          intent,
          Object.freeze({ deadline: envelope.deadline }),
        ]),
    },
    rawInput,
  );
  let creation: ReturnType<typeof captureLocalRepositoryPreparationObjectData> | undefined;
  let objects: Awaited<ReturnType<typeof captureLocalRepositoryPreparationObjectData>> | undefined;
  try {
    await held.owner.assertCurrent();
    current();
    creation = captureLocalRepositoryPreparationObjectData(
      context,
      held.request,
      held.allocationFacts,
      held.allocationFactsSha256,
      envelope.deadline,
      held.publicationPackedRefs,
      held.objectSource,
    );
    objects = await creation;
    await held.owner.assertCurrent();
    current();
    await held.approve();
    current();
    return await held.materialize(objects);
  } finally {
    try {
      if (creation) {
        const [result] = await Promise.allSettled([creation]);
        if (result.status === 'fulfilled') objects ??= result.value;
      }
      if (objects) await objects.dispose();
    } finally {
      await originalFull();
      current();
    }
  }
}
