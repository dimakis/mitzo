import { isDeepStrictEqual } from 'node:util';
import {
  TelosCreateSessionInputSchema,
  type OrdinaryWorkspaceSettings,
  type SessionLaunchConfig,
  type TelosWorkCommandReceipt,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import { TelosWorkError, TelosWorkStore } from './telos-work-store.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import type { createTelosWorkRoleHost } from './telos-work-role-host.js';
import {
  SessionLaunchError,
  type SessionLaunchStore,
  type RetainedSessionLaunch,
} from './session-launch-store.js';
import type {
  SessionLaunchAuthority,
  TelosSessionAssignmentReceipt,
  TelosSessionLaunchPort,
} from './session-launch-service.js';

export interface TelosSessionLaunchDependencies {
  store: SessionLaunchStore;
  events: EventStore;
  dbPath(): string;
  ordinaryConversation(id: string): boolean;
  roleHost(authority: SessionLaunchAuthority): ReturnType<typeof createTelosWorkRoleHost>;
  qualify(configuration: SessionLaunchConfig, authority: SessionLaunchAuthority): Promise<void>;
  prepareSettings(
    configuration: SessionLaunchConfig,
    authority: SessionLaunchAuthority,
  ): Promise<OrdinaryWorkspaceSettings>;
}

/** Agent proposal + operator-reviewed creation, composed over the canonical
 * role journal. No transcript, provider, adoption or execution port is exposed. */
export function createTelosSessionLaunchHost(deps: TelosSessionLaunchDependencies) {
  const usingWork = <T>(action: (work: TelosWorkStore) => T): T => {
    // These are denial/read fences, including inside the role owner's writer
    // transaction. Never acquire a second schema writer from its callback.
    const work = TelosWorkStore.openReadOnly(deps.dbPath(), {
      ordinaryConversation: deps.ordinaryConversation,
    });
    try {
      return action(work);
    } catch (error) {
      if (error instanceof TelosWorkError)
        throw new SessionLaunchError(error.message, error.code === 'unauthorized' ? 403 : 409, {
          cause: error,
        });
      throw error;
    } finally {
      work.close();
    }
  };
  const actor = (authority: SessionLaunchAuthority) => ({
    kind: 'operator' as const,
    id: authority.authSessionId,
  });
  const current = (authority: SessionLaunchAuthority) => {
    authority.signal.throwIfAborted();
    authority.assertCurrent();
  };
  const sourceScope = (sourceSessionId: string, itemId: string) =>
    usingWork((work) => {
      const scope = work.sessionCreationScope(sourceSessionId, itemId);
      const meta = deps.events.getSession(sourceSessionId);
      const context = resolveTelosWorkRoleContext(
        deps.events,
        sourceSessionId,
        meta?.accountBinding ?? undefined,
      );
      if (!context || context.role !== 'lead' || context.itemId !== scope.parentItemId)
        throw new SessionLaunchError(
          'The originating chat must retain the current assigned parent lead role.',
          403,
        );
      return scope;
    });
  const retained = (record: RetainedSessionLaunch, authority: SessionLaunchAuthority) =>
    usingWork((work) => work.ordinaryRoleSetupForHost(record.proposalId, actor(authority)));
  const assertScope = (record: RetainedSessionLaunch, authority: SessionLaunchAuthority) => {
    current(authority);
    if (!record.telos || !record.telosReview || record.telosReviewOwner !== authority.authSessionId)
      throw new SessionLaunchError('The original authenticated work review is required.', 403);
    // Completed canonical receipts are historical facts, not a new delegation.
    if (retained(record, authority)?.receipt) return;
    const { sourceSnapshotIds, artifactRefs, ...expected } = record.telos;
    if (!isDeepStrictEqual(sourceScope(record.sourceSessionId, record.telos.itemId), expected))
      throw new SessionLaunchError(
        'Work or originating lead assignment changed. Review the selected work again.',
      );
    if (
      !isDeepStrictEqual(
        sourceSnapshotIds,
        record.telosReview.selection.sources.map((source) => source.snapshotId),
      ) ||
      !isDeepStrictEqual(artifactRefs, record.telosReview.selection.artifacts)
    )
      throw new SessionLaunchError('Original reviewed work sources required.');
  };
  const request = (
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
    raw: unknown,
  ) => ({
    actor: actor(authority),
    raw,
    signal: authority.signal,
    assertAuthorized: () => assertScope(record, authority),
  });
  async function inspect(
    record: RetainedSessionLaunch,
    authority: SessionLaunchAuthority,
  ): Promise<TelosSessionAssignmentReceipt | { state: 'uncertain' }> {
    assertScope(record, authority);
    const operation = retained(record, authority);
    if (!operation?.receipt) return { state: 'uncertain' };
    const input = operation.setup.input;
    if (!record.telosSetup || !isDeepStrictEqual(input, record.telosSetup.input))
      throw new SessionLaunchError('Original retained role operation changed.');
    const assigned = operation.receipt.work.assignments.find((a) => a.role === input.role);
    const preparation = deps.events.getOrdinaryWorkspaceSessionPreparation(
      operation.setup.allocationOperationId,
    );
    const childSessionId = assigned?.conversation.conversationId;
    const session = childSessionId ? deps.events.getSession(childSessionId) : undefined;
    const context = childSessionId
      ? resolveTelosWorkRoleContext(
          deps.events,
          childSessionId,
          session?.accountBinding ?? undefined,
        )
      : undefined;
    if (
      !assigned ||
      !childSessionId ||
      !preparation ||
      preparation.sessionId !== childSessionId ||
      childSessionId === record.sourceSessionId ||
      !deps.ordinaryConversation(childSessionId) ||
      !isDeepStrictEqual(preparation.settings, input.settings) ||
      !isDeepStrictEqual(context, input.contextSelection)
    )
      throw new SessionLaunchError(
        'Original assigned session custody is unavailable. Recover this role operation.',
      );
    const selection = await deps.roleHost(authority).context(
      request(record, authority, {
        itemId: input.itemId,
        role: input.role,
        sourceSnapshotIds: input.contextSelection.sources.map((s) => s.snapshotId),
        artifactRefs: input.contextSelection.artifacts,
      }),
    );
    if (
      !isDeepStrictEqual(selection.sources, input.contextSelection.sources) ||
      !isDeepStrictEqual(selection.artifacts, input.contextSelection.artifacts)
    )
      throw new SessionLaunchError('Retained role material is unavailable.');
    current(authority);
    return {
      state: 'assigned',
      childSessionId,
      preparationId: input.settings.workspace.preparationId,
      itemId: input.itemId,
      role: assigned.role,
      assignmentRevision: assigned.revision,
      execution: 'not_started',
    };
  }
  const host: TelosSessionLaunchPort = {
    async validate(record, edits, authority) {
      assertScope(record, authority);
      if (edits.configuration.extraTools.length)
        throw new SessionLaunchError(
          'Select tools through the child agent profile. Additional launch tools are not supported by reviewed Telos role setup.',
        );
      await deps.qualify(edits.configuration, authority);
      assertScope(record, authority);
      if (!retained(record, authority)?.receipt) {
        const reviewed = record.telosReview!;
        const selection = await deps.roleHost(authority).context(
          request(record, authority, {
            itemId: record.telos!.itemId,
            role: record.telos!.role,
            sourceSnapshotIds: record.telos!.sourceSnapshotIds,
            artifactRefs: record.telos!.artifactRefs,
          }),
        );
        if (!isDeepStrictEqual(selection, reviewed.selection))
          throw new SessionLaunchError(
            'Reviewed work context changed. Review the selected work again.',
          );
      }
      assertScope(record, authority);
    },
    async create(record, authority) {
      await host.validate(record, record, authority);
      let setup = deps.store.get(record.proposalId, 'user').telosSetup;
      if (!setup) {
        const settings = await deps.prepareSettings(record.configuration, authority);
        assertScope(record, authority);
        setup = deps.store.retainTelosSetup(record.proposalId, 'user', {
          version: 2,
          presentationRef: record.telosReview!.presentationRef,
          input: {
            version: 2,
            requestId: record.proposalId,
            itemId: record.telos!.itemId,
            role: record.telos!.role,
            expectedRevision: record.telos!.expectedRevision,
            expectedAssignmentRevision: 0,
            createOnly: true,
            settings,
            contextSelection: record.telosReview!.selection,
          },
        });
      }
      const receipt: TelosWorkCommandReceipt = await deps
        .roleHost(authority)
        .setupReviewedOrdinary(request(record, authority, setup));
      const stored = deps.store.get(record.proposalId, 'user');
      const assigned = await inspect(stored, authority);
      if (assigned.state !== 'assigned' || receipt.work.itemId !== record.telos!.itemId)
        throw new SessionLaunchError('The original role assignment is not confirmed.');
      // Naming a newly assigned chat changes no runtime, transcript or authority.
      const metadata = deps.events.getSession(assigned.childSessionId);
      if (!metadata?.summary) {
        deps.events.upsertSession({ sessionId: assigned.childSessionId, summary: record.title });
        deps.events.markManuallyRenamed(assigned.childSessionId);
      }
      return assigned;
    },
    inspect,
  };
  return {
    ...host,
    async propose(sourceSessionId: string, raw: unknown, authority: SessionLaunchAuthority) {
      const input = TelosCreateSessionInputSchema.parse(raw);
      current(authority);
      const scope = sourceScope(sourceSessionId, input.itemId);
      if (scope.expectedRevision !== input.expectedRevision)
        throw new SessionLaunchError(
          'Work revision changed. Read the selected work before proposing its session.',
        );
      const assertAuthorized = () => {
        current(authority);
        if (!isDeepStrictEqual(sourceScope(sourceSessionId, input.itemId), scope))
          throw new SessionLaunchError(
            'The selected work or its assigned lead changed during review.',
          );
      };
      const telosReview = await deps.roleHost(authority).review({
        actor: actor(authority),
        signal: authority.signal,
        assertAuthorized,
        raw: {
          itemId: scope.itemId,
          role: scope.role,
          sourceSnapshotIds: input.sourceSnapshotIds,
          artifactRefs: input.artifactRefs,
        },
      });
      assertAuthorized();
      return {
        telos: {
          ...scope,
          sourceSnapshotIds: input.sourceSnapshotIds,
          artifactRefs: input.artifactRefs,
        },
        telosReview,
        telosReviewOwner: authority.authSessionId,
      };
    },
  };
}
