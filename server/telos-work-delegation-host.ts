import { isDeepStrictEqual } from 'node:util';
import {
  TelosStartSliceInputSchema,
  TelosOrdinaryWorkDelegationInputSchema,
  TelosOrdinaryWorkDelegationIntentSchema,
  TelosLegacyWorkDelegationIntentSchema,
  OrdinaryWorkspaceSettingsSchema,
  CollaborationSettingsSchema,
  type TelosOrdinaryWorkDelegationInput,
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

type OrdinaryOwnerDependencies = ConstructorParameters<typeof TelosWorkDelegation<'ordinary'>>[0];
type AnyScope = TelosWorkDelegationScope<'repository' | 'ordinary'>;
type AnyInput = TelosWorkDelegationInput | TelosOrdinaryWorkDelegationInput;
type OwnerDependencies = ConstructorParameters<typeof TelosWorkDelegation<'repository'>>[0];
export interface TelosWorkDelegationHostDependencies {
  dbPath(): string;
  events: EventStore;
  tasks: TaskStore;
  workspaces(): RepositoryWorkspaces;
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
  resolvePreparation: OwnerDependencies['resolvePreparation'];
  authorizeSettings: OwnerDependencies['authorize'];
  ordinary?: {
    qualifySettings: NonNullable<OrdinaryOwnerDependencies['qualifyOrdinarySettings']>;
    resolvePreparation: OrdinaryOwnerDependencies['resolvePreparation'];
    authorizeSettings: OrdinaryOwnerDependencies['authorize'];
    dispatch(
      owner: TelosWorkDelegation<'ordinary'>,
      actor: TelosWorkActor,
      input: TelosOrdinaryWorkDelegationInput,
      signal: AbortSignal,
    ): Promise<TelosWorkDelegationReceipt>;
  };
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
  async function delegate(
    request: TelosWorkRoleRequest,
    explicitOrdinary = false,
  ): Promise<TelosWorkDelegationReceipt> {
    const leadMetadata =
      request.actor.kind === 'conversation' ? deps.events.getSession(request.actor.id) : null;
    const ordinary =
      explicitOrdinary ||
      (request.actor.kind === 'conversation' && leadMetadata?.ordinaryWorkspaceId != null);
    if (
      ordinary &&
      (!deps.ordinary || (leadMetadata && leadMetadata.repositoryWorkspaceId != null))
    )
      throw new TelosWorkError('invalid', 'Original ordinary delegation owner required');
    const ordinaryScope = (scope: AnyScope): TelosWorkDelegationScope<'ordinary'> => ({
      actor: scope.actor,
      intent: TelosOrdinaryWorkDelegationIntentSchema.parse(scope.intent),
      settings: OrdinaryWorkspaceSettingsSchema.parse(scope.settings),
    });
    const repositoryScope = (scope: AnyScope): TelosWorkDelegationScope<'repository'> => ({
      actor: scope.actor,
      intent: TelosLegacyWorkDelegationIntentSchema.parse(scope.intent),
      settings: CollaborationSettingsSchema.parse(scope.settings),
    });
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
        authorizeSource: (_actor, id) => (deps.sourceConversation ?? deps.ordinaryConversation)(id),
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
      let input: AnyInput;
      if (actor.kind === 'operator') {
        input = (
          ordinary ? TelosOrdinaryWorkDelegationInputSchema : TelosWorkDelegationInputSchema
        ).parse(structuredClone(request.raw));
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
          (ordinary
            ? work.ordinaryDelegationRequestForHost(raw.requestId, actor)
            : work.delegationRequestForHost(raw.requestId, actor)) ??
          (raw.mode === 'start'
            ? ordinary
              ? work.latestOrdinaryDelegationForHost(raw.childItemId)
              : work.latestDelegationForHost(raw.childItemId)
            : null);
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
          const settings = ordinary
            ? deps.events.getOrdinaryWorkspaceConversationSettings(actor.id)
            : deps.events.getOrdinaryConversationSettings(actor.id);
          if (!settings)
            throw new TelosWorkError('unauthorized', 'Original ordinary lead settings required');
          const contextSelection = review(
            { childItemId: raw.childItemId, leadConversationId: actor.id },
            raw.sourceSnapshotIds ?? [],
            raw.artifactRefs ?? [],
          );
          input = (
            ordinary ? TelosOrdinaryWorkDelegationInputSchema : TelosWorkDelegationInputSchema
          ).parse({
            ...(ordinary ? { version: 2 } : {}),
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
      const assertScope = (scope: AnyScope) => {
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
          const settings = ordinary
            ? deps.events.getOrdinaryWorkspaceConversationSettings(actor.id)
            : deps.events.getOrdinaryConversationSettings(actor.id);
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
      const common = {
        work,
        events: deps.events,
        tasks: deps.tasks,
        workspaces: deps.workspaces(),
        resolvePreparation: (scope: AnyScope, signal: AbortSignal) =>
          ordinary
            ? deps.ordinary!.resolvePreparation(ordinaryScope(scope), signal)
            : deps.resolvePreparation(repositoryScope(scope), signal),
        authorize: async (scope: AnyScope, signal: AbortSignal) => {
          assertScope(scope);
          if (ordinary)
            await deps.ordinary!.authorizeSettings(ordinaryScope(structuredClone(scope)), signal);
          else await deps.authorizeSettings(repositoryScope(structuredClone(scope)), signal);
          assertScope(scope);
        },
        assertBeforeApply: assertScope,
        capturePresentation: (scope: AnyScope) => {
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
      };
      if (ordinary) {
        const owner = new TelosWorkDelegation<'ordinary'>({
          ...common,
          workspaceKind: 'ordinary',
          qualifyOrdinarySettings: deps.ordinary!.qualifySettings,
        });
        return await deps.ordinary!.dispatch(
          owner,
          actor,
          TelosOrdinaryWorkDelegationInputSchema.parse(input),
          request.signal,
        );
      }
      const owner = new TelosWorkDelegation<'repository'>(common);
      return await deps.dispatch(
        owner,
        actor,
        TelosWorkDelegationInputSchema.parse(input),
        request.signal,
      );
    } finally {
      artifacts?.close();
      work.close();
    }
  }
  return {
    delegate: (request: TelosWorkRoleRequest) => delegate(request),
    delegateOrdinary: (request: TelosWorkRoleRequest) => delegate(request, true),
  };
}
