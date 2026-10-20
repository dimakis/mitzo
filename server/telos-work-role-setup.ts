import { isDeepStrictEqual } from 'node:util';
import {
  TelosWorkRoleSetupInputSchema,
  type TelosWorkRoleSetupIntent,
  type TelosWorkCommandReceipt,
  type TelosWorkRoleSetupRequestIntent,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkError, type TelosWorkActor, type TelosWorkStore } from './telos-work-store.js';
import {
  TelosWorkRoleContextSelectionSchema,
  renderTelosWorkRoleContext,
} from './telos-work-role-context.js';

export type TelosWorkRoleSetupScope = { actor: TelosWorkActor; setup: TelosWorkRoleSetupIntent };
type Preparation = Omit<
  Parameters<RepositoryWorkspaces['prepareOrdinarySession']>[0],
  'allocationOperationId' | 'id' | 'settings' | 'signal'
>;

/** Silent ordinary setup only. No child allocator, execution queue or provider port.
 * The host must prove exact operator/settings/context authority anew across waits.
 */
export class TelosWorkRoleSetup {
  constructor(
    private readonly deps: {
      work: TelosWorkStore;
      events: EventStore;
      workspaces: RepositoryWorkspaces;
      authorize(input: TelosWorkRoleSetupScope, signal: AbortSignal): Promise<void>;
      /** Synchronous final denial fence, within the work transaction. */
      assertBeforeApply(input: TelosWorkRoleSetupScope & { conversationId: string }): void;
      resolvePreparation(input: TelosWorkRoleSetupScope, signal: AbortSignal): Promise<Preparation>;
      /** Retain exact versioned role context through the existing ordinary owner. */
      retainContext(
        input: TelosWorkRoleSetupScope & { conversationId: string },
        signal: AbortSignal,
      ): Promise<void>;
    },
  ) {}

  async setup(
    actorInput: TelosWorkActor,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<TelosWorkCommandReceipt> {
    const actor = structuredClone(actorInput);
    const input = TelosWorkRoleSetupInputSchema.parse(structuredClone(raw));
    const contextSelection = TelosWorkRoleContextSelectionSchema.parse(input.contextSelection);
    input.contextSelection = contextSelection;
    if (contextSelection.itemId !== input.itemId || contextSelection.role !== input.role)
      throw new TelosWorkError('invalid', 'Role context selection scope mismatch');
    renderTelosWorkRoleContext(contextSelection);
    signal.throwIfAborted();
    return runTelosWorkRoleSetup(actor, input, signal, {
      prepare: () => this.deps.work.prepareRoleSetup(input, actor),
      authorize: (scope, signal) => this.deps.authorize(scope, signal),
      getReceipt: (id) => this.deps.events.getOrdinarySessionPreparation(id),
      allocate: async (scope, authorize) => {
        const resolved = structuredClone(await this.deps.resolvePreparation(scope, signal));
        await authorize();
        return (
          await this.deps.workspaces.prepareOrdinarySession(
            {
              ...resolved,
              allocationOperationId: scope.setup.allocationOperationId,
              id: scope.setup.input.settings.repositoryWorkspaceId,
              settings: structuredClone(scope.setup.input.settings),
              signal,
            },
            this.deps.events,
          )
        ).receipt;
      },
      retainContext: (scope, signal) => this.deps.retainContext(scope, signal),
      assertBeforeApply: (scope) => this.deps.assertBeforeApply(scope),
      complete: (setup, id, assert) => this.deps.work.completeRoleSetup(setup, id, actor, assert),
    });
  }
}

type RoleScope<T extends TelosWorkRoleSetupRequestIntent> = { actor: TelosWorkActor; setup: T };
/** Shared role workflow. Allocation and persistence remain in their existing owners. */
export async function runTelosWorkRoleSetup<
  T extends TelosWorkRoleSetupRequestIntent,
  R extends { allocationOperationId: string; sessionId: string; settings: T['input']['settings'] },
>(
  actor: TelosWorkActor,
  input: T['input'],
  signal: AbortSignal,
  deps: {
    prepare(): { setup: T; receipt: TelosWorkCommandReceipt | null };
    authorize(scope: RoleScope<T>, signal: AbortSignal): Promise<void>;
    verifyRetained?(scope: RoleScope<T>): Promise<void>;
    getReceipt(operationId: string): R | undefined;
    allocate(scope: RoleScope<T>, authorize: () => Promise<void>): Promise<R>;
    retainContext(
      scope: RoleScope<T> & { conversationId: string },
      signal: AbortSignal,
    ): Promise<void>;
    assertBeforeApply(scope: RoleScope<T> & { conversationId: string }): void;
    complete(
      setup: T,
      conversationId: string,
      assertBeforeApply: () => void,
    ): TelosWorkCommandReceipt;
  },
): Promise<TelosWorkCommandReceipt> {
  // Persist one operation before asynchronous preparation, including uncertain
  // failures; an exact retry always recovers this operation's original session.
  const retained = deps.prepare();
  const setup = structuredClone(retained.setup);
  const scope = () => structuredClone({ actor, setup });
  const authorize = async () => {
    signal.throwIfAborted();
    await deps.authorize(scope(), signal);
    signal.throwIfAborted();
  };
  await authorize();
  if (retained.receipt) {
    await deps.verifyRetained?.(scope());
    return retained.receipt;
  }
  let receipt = deps.getReceipt(setup.allocationOperationId);
  const recoveredAllocation = receipt !== undefined;
  if (!receipt) {
    receipt = await deps.allocate(scope(), authorize);
    await authorize();
  }
  if (
    receipt.allocationOperationId !== setup.allocationOperationId ||
    !isDeepStrictEqual(receipt.settings, setup.input.settings)
  )
    throw new TelosWorkError('conflict', 'Ordinary role preparation scope mismatch');
  // A committed ordinary preparation can survive a lost allocation response
  // before the role receipt exists. Recovery must renew the original workspace
  // custody just like replay of a completed role, before retaining context.
  if (recoveredAllocation) {
    await deps.verifyRetained?.(scope());
    await authorize();
  }
  await deps.retainContext({ ...scope(), conversationId: receipt.sessionId }, signal);
  await authorize();
  const conversationId = receipt.sessionId;
  return deps.complete(setup, conversationId, () => {
    signal.throwIfAborted();
    deps.assertBeforeApply({ ...scope(), conversationId });
  });
}
