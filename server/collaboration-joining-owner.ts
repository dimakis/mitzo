import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationJoinInputSchema,
  type CollaborationJoin,
  type CollaborationJoinInput,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

type Scope = { operatorId: string; collaborationId: string };
type JoinScope = Scope & { join: CollaborationJoin; phase: 'confirm' | 'recover' };
type Preparation = Omit<
  Parameters<RepositoryWorkspaces['prepareOrdinarySession']>[0],
  'allocationOperationId' | 'id' | 'settings' | 'signal'
>;

export interface OrdinaryCollaborationJoiningAuthority {
  /** Reauthorize the retained review's original operator, exact source/settings and
   * authoritative native capacity. Caller settings and saved capacity numbers are
   * not authority. No production resolver exists until the runtime supplies proof.
   */
  authorizeConfirmation(
    input: Scope & { input: CollaborationJoinInput },
    signal: AbortSignal,
  ): Promise<void>;
  /** Fresh source/access/settings/capacity fence, also after asynchronous allocation.
   * This check must support already-linked recovery without granting execution.
   */
  authorizeJoin(input: JoinScope, signal: AbortSignal): Promise<void>;
}

/** Structural port for an authenticated router; only public join records escape. */
export interface OrdinaryCollaborationJoiningPort {
  confirm(
    operatorId: string,
    collaborationId: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<CollaborationJoin>;
  recover(
    operatorId: string,
    collaborationId: string,
    joinId: string,
    signal: AbortSignal,
  ): Promise<CollaborationJoin>;
}

/** Orchestration only. EventStore owns joins/receipts; RepositoryWorkspaces owns
 * durable silent preparation. No second ledger, provider start, send or queue.
 * Deliberately not installed in production without exact native capacity authority.
 */
export class OrdinaryCollaborationJoining implements OrdinaryCollaborationJoiningPort {
  constructor(
    private readonly deps: {
      store: EventStore;
      workspaces: RepositoryWorkspaces;
      authority: OrdinaryCollaborationJoiningAuthority;
      /** Trusted ordinary host resolver; not constructed from HTTP path/account claims.
       * Workspace/settings/operation identity always comes from the retained join.
       */
      resolvePreparation(input: JoinScope, signal: AbortSignal): Promise<Preparation>;
    },
  ) {}

  async confirm(
    operatorId: string,
    collaborationId: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<CollaborationJoin> {
    const scope = this.scope(operatorId, collaborationId);
    const input = CollaborationJoinInputSchema.parse(structuredClone(raw));
    signal.throwIfAborted();
    await this.deps.authority.authorizeConfirmation(
      { ...scope, input: structuredClone(input) },
      signal,
    );
    signal.throwIfAborted();
    const join = this.deps.store.collaborationConversation.prepareJoin(collaborationId, input);
    return this.finish(scope, join, 'confirm', signal);
  }

  async recover(
    operatorId: string,
    collaborationId: string,
    joinId: string,
    signal: AbortSignal,
  ): Promise<CollaborationJoin> {
    const scope = this.scope(operatorId, collaborationId);
    signal.throwIfAborted();
    const join = this.deps.store.collaborationConversation.getJoin(
      collaborationId,
      z.uuid().parse(joinId),
    );
    if (!join) throw new CollaborationContractError('not_found');
    return this.finish(scope, join, 'recover', signal);
  }

  private scope(operatorId: string, collaborationId: string): Scope {
    return {
      operatorId: z.string().min(1).max(200).regex(/^\S+$/).parse(operatorId),
      collaborationId: z.uuid().parse(collaborationId),
    };
  }

  private async finish(
    scope: Scope,
    join: CollaborationJoin,
    phase: JoinScope['phase'],
    signal: AbortSignal,
  ): Promise<CollaborationJoin> {
    const authorize = async () => {
      signal.throwIfAborted();
      await this.deps.authority.authorizeJoin(
        { ...scope, join: structuredClone(join), phase },
        signal,
      );
      signal.throwIfAborted();
    };
    await authorize();
    if (join.state === 'linked') return join;
    // A crash may leave preparation committed while the join is still pending.
    // Recover that owner's receipt directly; never ask a resolver to allocate anew.
    let receipt = this.deps.store.getOrdinarySessionPreparation(join.allocationOperationId);
    if (!receipt) {
      if (join.state !== 'pending_preparation')
        throw new CollaborationContractError('allocation_conflict');
      const resolved = structuredClone(
        await this.deps.resolvePreparation(
          { ...scope, join: structuredClone(join), phase },
          signal,
        ),
      );
      await authorize();
      receipt = (
        await this.deps.workspaces.prepareOrdinarySession(
          {
            ...resolved,
            allocationOperationId: join.allocationOperationId,
            id: join.settings.repositoryWorkspaceId,
            settings: structuredClone(join.settings),
            signal,
          },
          this.deps.store,
        )
      ).receipt;
    }
    if (
      receipt.allocationOperationId !== join.allocationOperationId ||
      !isDeepStrictEqual(receipt.settings, join.settings) ||
      (join.sessionId !== null && join.sessionId !== receipt.sessionId)
    )
      throw new CollaborationContractError('allocation_conflict');
    // Retain the durable allocation even if renewed access or membership later fails.
    // recordAllocation validates it through EventStore's existing allocation owner.
    join = this.deps.store.collaborationConversation.recordAllocation(
      scope.collaborationId,
      join.joinId,
      {
        operationId: join.allocationOperationId,
        sessionId: receipt.sessionId,
        settings: structuredClone(join.settings),
      },
    );
    await authorize();
    return this.deps.store.collaborationConversation.linkJoin(
      scope.collaborationId,
      join.joinId,
      join.membershipRevision,
    );
  }
}
