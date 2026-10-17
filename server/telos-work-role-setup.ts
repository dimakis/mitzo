import { isDeepStrictEqual } from 'node:util';
import {
  TelosWorkRoleSetupInputSchema,
  type TelosWorkRoleSetupIntent,
  type TelosWorkCommandReceipt,
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
    // Persist one operation before asynchronous preparation, including uncertain
    // failures; an exact retry always recovers this operation's original session.
    const retained = this.deps.work.prepareRoleSetup(input, actor);
    const setup = structuredClone(retained.setup);
    const scope = () => structuredClone({ actor, setup });
    const authorize = async () => {
      signal.throwIfAborted();
      await this.deps.authorize(scope(), signal);
      signal.throwIfAborted();
    };
    await authorize();
    if (retained.receipt) return retained.receipt;
    let receipt = this.deps.events.getOrdinarySessionPreparation(setup.allocationOperationId);
    if (!receipt) {
      const resolved = structuredClone(await this.deps.resolvePreparation(scope(), signal));
      await authorize();
      receipt = (
        await this.deps.workspaces.prepareOrdinarySession(
          {
            ...resolved,
            allocationOperationId: setup.allocationOperationId,
            id: setup.input.settings.repositoryWorkspaceId,
            settings: structuredClone(setup.input.settings),
            signal,
          },
          this.deps.events,
        )
      ).receipt;
      await authorize();
    }
    if (
      receipt.allocationOperationId !== setup.allocationOperationId ||
      !isDeepStrictEqual(receipt.settings, setup.input.settings)
    )
      throw new TelosWorkError('conflict', 'Ordinary role preparation scope mismatch');
    await this.deps.retainContext({ ...scope(), conversationId: receipt.sessionId }, signal);
    await authorize();
    const conversationId = receipt.sessionId;
    return this.deps.work.completeRoleSetup(setup, conversationId, actor, () => {
      signal.throwIfAborted();
      this.deps.assertBeforeApply({ ...scope(), conversationId });
    });
  }
}
