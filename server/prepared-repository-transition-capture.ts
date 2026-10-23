import { isDeepStrictEqual } from 'node:util';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type {
  PreparedRepositoryTransitionCaptureInput,
  PreparedRepositoryTransitionCaptureOwners,
  PreparedRepositoryTransitionProof,
} from './prepared-repository-transition.js';
import { freezePendingHostTaskData } from './pending-host-task.js';
import { projectQualifiedPreparedRepositoryTransitionFacts } from './qualified-prepared-repository-transition.js';
import {
  captureQualifiedLocalRepositoryTask,
  snapshotQualifiedLocalRepositoryPublication,
} from './qualified-local-repository-task.js';
import { capturePreparedRepositoryReader } from './local-repository-native-read.js';
import { LocalRepositoryReadAccess } from './local-repository-read-access.js';

const unavailable = () => Error('Prepared repository transition unavailable');
function value(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !('value' in descriptor)) throw unavailable();
  return descriptor.value;
}
function callback(object: object, key: string): (...args: never[]) => unknown {
  const fn = value(object, key);
  if (typeof fn !== 'function') throw unavailable();
  return fn as (...args: never[]) => unknown;
}
function strictVoid(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw unavailable();
}
/** Copy plain own DATA before the first await, without invoking accessors or
 * coercion. This preserves existing field order; it is not a new hash format. */
function snapshot(input: unknown, depth = 0): unknown {
  if (depth > 16) throw unavailable();
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (!input || typeof input !== 'object') throw unavailable();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw unavailable();
  const keys = Reflect.ownKeys(input);
  if (keys.length > 32 || keys.some((key) => typeof key !== 'string')) throw unavailable();
  return Object.fromEntries(
    keys.map((key) => [key, snapshot(value(input, key as string), depth + 1)]),
  );
}

/** Private completed-turn producer. The supplied live scope and durable-result
 * owner are existing native authority ports, never historical Prepare grants.
 * No registration, continuation or native admission occurs here. */
export async function capturePreparedRepositoryTransition(
  service: RepositoryWorkspaces,
  input: PreparedRepositoryTransitionCaptureInput,
  owners: PreparedRepositoryTransitionCaptureOwners,
): Promise<Readonly<PreparedRepositoryTransitionProof> | undefined> {
  try {
    const selected = freezePendingHostTaskData(
      snapshot(input),
    ) as PreparedRepositoryTransitionCaptureInput;
    if (Buffer.byteLength(JSON.stringify(selected)) > 65536) throw unavailable();
    const scope = value(
      owners,
      'readScope',
    ) as PreparedRepositoryTransitionCaptureOwners['readScope'];
    if (!scope || !Object.isFrozen(scope)) throw unavailable();
    const originalSync = callback(scope, 'assertCurrentSync'),
      originalFull = callback(scope, 'revalidate'),
      originalQueue = callback(owners, 'assertNoQueuedOldWorkspaceCommandsSync'),
      originalResult = callback(owners, 'resultSha256');
    const signal = value(scope, 'signal');
    if (!(signal instanceof AbortSignal)) throw unavailable();
    let state: 'ready' | 'adopting' | 'closed' = 'ready';
    const ownerCurrent = () => {
      signal.throwIfAborted();
      if (
        value(owners, 'readScope') !== scope ||
        value(scope, 'assertCurrentSync') !== originalSync ||
        value(scope, 'revalidate') !== originalFull ||
        value(owners, 'assertNoQueuedOldWorkspaceCommandsSync') !== originalQueue ||
        value(owners, 'resultSha256') !== originalResult ||
        value(scope, 'signal') !== signal
      )
        throw unavailable();
      strictVoid(Reflect.apply(originalSync, scope, []));
      strictVoid(Reflect.apply(originalQueue, owners, []));
      if (
        value(owners, 'readScope') !== scope ||
        value(scope, 'assertCurrentSync') !== originalSync ||
        value(scope, 'revalidate') !== originalFull ||
        value(owners, 'assertNoQueuedOldWorkspaceCommandsSync') !== originalQueue ||
        value(owners, 'resultSha256') !== originalResult
      )
        throw unavailable();
      strictVoid(Reflect.apply(originalSync, scope, []));
    };
    const full = async () => {
      ownerCurrent();
      strictVoid(await Reflect.apply(originalFull, scope, []));
      ownerCurrent();
    };
    await full();
    const candidate = service.findPreparedRepositoryTransitionCandidate(selected);
    if (!candidate) {
      ownerCurrent();
      return undefined;
    }
    const resultDigest = () => {
      const result = Reflect.apply(originalResult, owners, [candidate.request]);
      if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) {
        void Promise.resolve(result).catch(() => {});
        throw unavailable();
      }
      return result;
    };
    const digest = resultDigest();
    const facts = projectQualifiedPreparedRepositoryTransitionFacts(candidate, selected, digest);
    const qualified = candidate.record.qualifiedLocalPreparation!;
    if (!qualified.publication || !qualified.allocationFacts) throw unavailable();
    const publication = snapshotQualifiedLocalRepositoryPublication(qualified.publication);
    const allocation = qualified.allocationFacts;
    const current = (adopting = false) => {
      if (state !== (adopting ? 'adopting' : 'ready')) throw unavailable();
      ownerCurrent();
      const actual = service.findPreparedRepositoryTransitionCandidate(selected);
      if (!actual || actual.rawRecord !== candidate.rawRecord) throw unavailable();
      if (resultDigest() !== facts.resultSha256) throw unavailable();
      const repository = service.getForConversation(selected.conversationId);
      if (selected.oldWorkspace.kind === 'repository') {
        if (
          !repository ||
          repository.id !== selected.oldWorkspace.id ||
          repository.directory !== selected.oldWorkspace.directory ||
          repository.state !== 'claimed' ||
          repository.sandbox ||
          !isDeepStrictEqual(repository.binding, selected.binding)
        )
          throw unavailable();
      } else {
        const ordinary = service.getOrdinaryWorkspaceForConversation(selected.conversationId);
        if (
          repository ||
          !ordinary ||
          ordinary.id !== selected.oldWorkspace.id ||
          ordinary.directory !== selected.oldWorkspace.directory ||
          ordinary.state !== 'claimed' ||
          !isDeepStrictEqual(ordinary.binding, selected.binding) ||
          !isDeepStrictEqual(ordinary.settings.binding, facts.request.runtimeBinding)
        )
          throw unavailable();
      }
      // Result/current-primary callbacks may themselves revoke the native owner.
      ownerCurrent();
    };
    const fresh = async (adopting = false) => {
      current(adopting);
      await full();
      current(adopting);
      let reader: Awaited<ReturnType<typeof capturePreparedRepositoryReader>> | undefined;
      try {
        reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
        current(adopting);
        const observed = await captureQualifiedLocalRepositoryTask(
          new LocalRepositoryReadAccess(reader),
          allocation,
          publication,
        );
        if (
          !isDeepStrictEqual(
            { ...observed, localSource: candidate.record.localSource },
            facts.newWorkspace.taskIdentity,
          )
        )
          throw unavailable();
        current(adopting);
      } finally {
        try {
          await reader?.dispose();
        } finally {
          await full();
          current(adopting);
        }
      }
      current(adopting);
    };
    await fresh();
    current();
    return Object.freeze({
      facts,
      assertCurrentSync: Object.freeze(() => {
        try {
          current();
        } catch {
          throw unavailable();
        }
      }),
      revalidate: Object.freeze(async () => {
        try {
          await fresh();
          current();
        } catch {
          throw unavailable();
        }
      }),
      adopt: Object.freeze(async (childCommandId: string) => {
        if (state !== 'ready') throw unavailable();
        state = 'adopting'; // Reserve this one attempt before any internal await.
        try {
          current(true);
          if (typeof childCommandId !== 'string' || !childCommandId || childCommandId.length > 256)
            throw unavailable();
          await fresh(true);
          current(true);
          // SAME fresh scope/queue/result/row fence is invoked by the custody
          // transaction immediately before its first SQL effect, without awaits.
          service.adoptPreparedRepositoryTransition(facts, childCommandId, () => current(true));
        } catch {
          throw unavailable();
        } finally {
          state = 'closed';
        }
      }),
    });
  } catch {
    throw unavailable();
  }
}
