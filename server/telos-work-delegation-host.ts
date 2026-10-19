import { isDeepStrictEqual } from 'node:util';
import {
  TelosStartSliceInputSchema,
  TelosWorkDelegationInputSchema,
  type TelosWorkDelegationInput,
  type TelosWorkDelegationReceipt,
} from '@mitzo/protocol';
import { TelosWorkDelegation, type TelosWorkDelegationScope } from './telos-work-delegation.js';
import { TelosWorkStore, TelosWorkError, type TelosWorkActor } from './telos-work-store.js';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { TelosSourceCapture } from './telos-source-capture.js';
import { reviewTelosWorkRoleContext } from './telos-work-role-review.js';
import { captureTelosWorkRolePresentation } from './telos-work-role-presentation.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import type { TelosWorkRoleRequest } from './telos-work-routes.js';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { TaskStore } from './task-store.js';

type OwnerDependencies = ConstructorParameters<typeof TelosWorkDelegation>[0];
export interface TelosWorkDelegationHostDependencies {
  dbPath(): string;
  events: EventStore;
  tasks: TaskStore;
  workspaces(): RepositoryWorkspaces;
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
  resolvePreparation: OwnerDependencies['resolvePreparation'];
  authorizeSettings: OwnerDependencies['authorize'];
  dispatch(
    owner: TelosWorkDelegation,
    actor: TelosWorkActor,
    input: TelosWorkDelegationInput,
    signal: AbortSignal,
  ): Promise<TelosWorkDelegationReceipt>;
}
/** Exact lead capability. Request JSON cannot select its actor, lead, account,
 * target, workspace or immutable role context. Operator requests use full reviewed
 * settings through the separately authenticated route. No provider port exists. */
export function createTelosWorkDelegationHost(deps: TelosWorkDelegationHostDependencies) {
  return {
    async delegate(request: TelosWorkRoleRequest): Promise<TelosWorkDelegationReceipt> {
      request.signal.throwIfAborted();
      request.assertAuthorized();
      const actor = structuredClone(request.actor);
      const work = new TelosWorkStore(deps.dbPath(), {
        ordinaryConversation: deps.ordinaryConversation,
        sourceConversation: deps.sourceConversation,
      });
      let artifacts: TelosArtifactStore | undefined;
      try {
        artifacts = new TelosArtifactStore(deps.dbPath());
        const capture = new TelosSourceCapture({
          events: deps.events,
          work,
          artifacts,
          assertAuthorized: () => {
            request.signal.throwIfAborted();
            request.assertAuthorized();
          },
          authorizeSource: (_actor, id) =>
            (deps.sourceConversation ?? deps.ordinaryConversation)(id),
          authorizeArtifact: (_actor, id) => artifacts!.userUploadAllowed(id),
        });
        const presentationReviewInput = (
          input: Pick<TelosWorkDelegationInput, 'childItemId' | 'leadConversationId'>,
          sources: string[],
          refs: TelosWorkDelegationInput['contextSelection']['artifacts'],
        ) => ({
          work,
          artifacts,
          actor,
          itemId: input.childItemId,
          role: 'worker' as const,
          selectedSourceSnapshotIds: sources,
          selectedArtifactRefs: refs,
          ...(actor.kind === 'conversation'
            ? {
                readTarget: (id: string) =>
                  work.readDelegationTarget(actor.id, input.childItemId, id),
                readReviewedSource: (id: string) =>
                  capture.readForDelegation(actor.id, input.childItemId, id),
              }
            : { readReviewedSource: (id: string) => capture.read(input.childItemId, id, actor) }),
        });
        const review = (...args: Parameters<typeof presentationReviewInput>) =>
          reviewTelosWorkRoleContext(presentationReviewInput(...args));
        let input: TelosWorkDelegationInput;
        if (actor.kind === 'operator') {
          input = TelosWorkDelegationInputSchema.parse(structuredClone(request.raw));
        } else {
          const raw = TelosStartSliceInputSchema.parse(structuredClone(request.raw));
          const leadSession = deps.events.getSession(actor.id);
          const lead = resolveTelosWorkRoleContext(
            deps.events,
            actor.id,
            leadSession?.accountBinding ?? undefined,
          );
          if (!lead || lead.role !== 'lead' || !deps.ordinaryConversation(actor.id))
            throw new TelosWorkError('unauthorized', 'Bound ordinary outcome lead required');
          work.readDelegationTarget(actor.id, raw.childItemId, lead.itemId);
          const existing =
            work.delegationRequestForHost(raw.requestId, actor) ??
            (raw.mode === 'start' ? work.latestDelegationForHost(raw.childItemId) : null);
          if (existing) {
            if (
              existing.input.childItemId !== raw.childItemId ||
              existing.input.leadItemId !== lead.itemId ||
              existing.input.leadConversationId !== actor.id ||
              (raw.sourceSnapshotIds &&
                !isDeepStrictEqual(
                  raw.sourceSnapshotIds,
                  existing.input.contextSelection.sources.map((s) => s.snapshotId),
                )) ||
              (raw.artifactRefs &&
                !isDeepStrictEqual(raw.artifactRefs, existing.input.contextSelection.artifacts))
            )
              throw new TelosWorkError(
                'conflict',
                'Delegation request identity or selected scope changed',
              );
            // An alias may point to a canonical retry attempt. Preserve the
            // incoming command identity for its request fingerprint while the
            // work owner recovers that attempt's original immutable intent.
            input = {
              ...structuredClone(existing.input),
              requestId: raw.requestId,
              mode: raw.mode,
              predecessorAttemptId: raw.predecessorAttemptId,
            };
          } else {
            const settings = deps.events.getOrdinaryConversationSettings(actor.id);
            if (!settings)
              throw new TelosWorkError('unauthorized', 'Original ordinary lead settings required');
            const contextSelection = review(
              { childItemId: raw.childItemId, leadConversationId: actor.id },
              raw.sourceSnapshotIds ?? [],
              raw.artifactRefs ?? [],
            );
            input = TelosWorkDelegationInputSchema.parse({
              requestId: raw.requestId,
              leadItemId: lead.itemId,
              childItemId: raw.childItemId,
              leadConversationId: actor.id,
              expectedRevision: contextSelection.brief.revision,
              mode: raw.mode,
              predecessorAttemptId: raw.predecessorAttemptId,
              settings,
              contextSelection,
            });
          }
        }
        const assertScope = (scope: TelosWorkDelegationScope) => {
          request.signal.throwIfAborted();
          request.assertAuthorized();
          if (
            !isDeepStrictEqual(scope.actor, actor) ||
            scope.intent.input.childItemId !== input.childItemId ||
            scope.intent.input.leadItemId !== input.leadItemId ||
            scope.intent.input.leadConversationId !== input.leadConversationId
          )
            throw new TelosWorkError('unauthorized', 'Exact delegation scope changed');
          const selected = scope.intent.input.contextSelection;
          const current = review(
            scope.intent.input,
            selected.sources.map((s) => s.snapshotId),
            selected.artifacts,
          );
          if (!work.attemptForHost(scope.intent.attemptId) && !isDeepStrictEqual(current, selected))
            throw new TelosWorkError(
              'conflict',
              'Exact reviewed delegation context revisions required',
            );
          if (
            !isDeepStrictEqual(current.sources, selected.sources) ||
            !isDeepStrictEqual(current.artifacts, selected.artifacts)
          )
            throw new TelosWorkError('unauthorized', 'Retained delegation material changed');
          if (!work.delegationCommittedForHost(scope.intent.attemptId)) {
            const semantic = (context: typeof selected) => ({
              itemId: context.itemId,
              role: context.role,
              brief: { text: context.brief.text, sha256: context.brief.sha256 },
              parents: context.parentCriteria.map((p) => ({
                itemId: p.itemId,
                criteria: p.criteria,
              })),
              goal: { itemId: context.overallGoal.itemId, text: context.overallGoal.text },
              lead: context.leadConversationId,
            });
            if (!isDeepStrictEqual(semantic(current), semantic(selected)))
              throw new TelosWorkError('conflict', 'Reviewed delegation context changed');
          }
          if (actor.kind === 'conversation') {
            const session = deps.events.getSession(actor.id);
            const lead = resolveTelosWorkRoleContext(
              deps.events,
              actor.id,
              session?.accountBinding ?? undefined,
            );
            const settings = deps.events.getOrdinaryConversationSettings(actor.id);
            const original = scope.intent.input.settings;
            // A completed creation receipt survives future inference changes.
            // Its worker still retains the original model/thinking selection.
            const currentAuthority =
              settings && work.delegationCommittedForHost(scope.intent.attemptId)
                ? {
                    ...settings,
                    selection: {
                      ...settings.selection,
                      model: original.selection.model,
                      thinking: original.selection.thinking,
                    },
                  }
                : settings;
            if (
              lead?.role !== 'lead' ||
              lead.itemId !== scope.intent.input.leadItemId ||
              !isDeepStrictEqual(currentAuthority, original)
            )
              throw new TelosWorkError('unauthorized', 'Original bound lead settings changed');
          }
        };
        const owner = new TelosWorkDelegation({
          work,
          events: deps.events,
          tasks: deps.tasks,
          workspaces: deps.workspaces(),
          resolvePreparation: deps.resolvePreparation,
          authorize: async (scope, signal) => {
            assertScope(scope);
            await deps.authorizeSettings(structuredClone(scope), signal);
            assertScope(scope);
          },
          assertBeforeApply: assertScope,
          capturePresentation: (scope) => {
            assertScope(scope);
            const selected = scope.intent.input.contextSelection;
            return captureTelosWorkRolePresentation(
              presentationReviewInput(
                scope.intent.input,
                selected.sources.map((source) => source.snapshotId),
                selected.artifacts,
              ),
              selected,
            );
          },
        });
        return await deps.dispatch(owner, actor, input, request.signal);
      } finally {
        artifacts?.close();
        work.close();
      }
    },
  };
}
