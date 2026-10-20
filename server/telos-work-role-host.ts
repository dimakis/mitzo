import type { TelosOrdinaryWorkRoleSetup } from './telos-ordinary-work-role-setup.js';
import {
  TelosWorkRoleSetupIntentSchema,
  TelosOrdinaryWorkRoleSetupIntentSchema,
  TelosOrdinaryWorkRoleSetupInputSchema,
  TelosOrdinaryWorkReviewedRoleSetupInputSchema,
  type TelosWorkRoleSetupRequestIntent,
} from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import {
  TelosWorkRoleSetupInputSchema,
  TelosWorkRoleContextRequestSchema,
  type TelosWorkCommandReceipt,
  type TelosWorkRoleContextReview,
  TelosWorkReviewedRoleSetupInputSchema,
  type TelosWorkRolePresentationRef,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkRoleSetup } from './telos-work-role-setup.js';
import type { TelosWorkRoleRequest } from './telos-work-routes.js';
import {
  TelosWorkRoleContextSelectionSchema,
  retainTelosWorkRoleContext,
  renderTelosWorkRoleContext,
  type TelosWorkRoleContextSelection,
} from './telos-work-role-context.js';
import { TelosWorkStore, TelosWorkError, type TelosWorkActor } from './telos-work-store.js';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { reviewTelosWorkRoleContext } from './telos-work-role-review.js';
import { TelosSourceCapture } from './telos-source-capture.js';
import {
  captureTelosWorkRolePresentation,
  retainTelosWorkRolePresentation,
} from './telos-work-role-presentation.js';

type SetupDependencies = ConstructorParameters<typeof TelosWorkRoleSetup>[0];
type OrdinarySetupDependencies = ConstructorParameters<typeof TelosOrdinaryWorkRoleSetup>[0];
type SetupScope = { actor: TelosWorkActor; setup: TelosWorkRoleSetupRequestIntent };
export interface TelosWorkRoleHostDependencies {
  dbPath(): string;
  events: EventStore;
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
  workspaces(): RepositoryWorkspaces;
  resolvePreparation: SetupDependencies['resolvePreparation'];
  authorizeSettings: SetupDependencies['authorize'];
  ordinary?: {
    resolveSelection: OrdinarySetupDependencies['resolveSelection'];
    authorizeSettings: OrdinarySetupDependencies['authorize'];
  };
}
const ReviewInput = TelosWorkRoleContextRequestSchema;

export function createTelosWorkRoleHost(deps: TelosWorkRoleHostDependencies): {
  context(request: TelosWorkRoleRequest): Promise<TelosWorkRoleContextSelection>;
  setupReviewed(request: TelosWorkRoleRequest): Promise<TelosWorkCommandReceipt>;
  review(request: TelosWorkRoleRequest): Promise<TelosWorkRoleContextReview>;
  setup(request: TelosWorkRoleRequest): Promise<TelosWorkCommandReceipt>;
  setupOrdinary(request: TelosWorkRoleRequest): Promise<TelosWorkCommandReceipt>;
  setupReviewedOrdinary(request: TelosWorkRoleRequest): Promise<TelosWorkCommandReceipt>;
} {
  async function usingStores<T>(
    request: TelosWorkRoleRequest,
    action: (work: TelosWorkStore, artifacts: TelosArtifactStore) => Promise<T>,
  ): Promise<T> {
    request.signal.throwIfAborted();
    request.assertAuthorized();
    if (request.actor.kind !== 'operator' || !request.actor.id.trim())
      throw new TelosWorkError('unauthorized', 'Interactive operator authority required');
    const path = deps.dbPath();
    const work = new TelosWorkStore(path, {
      ordinaryConversation: deps.ordinaryConversation,
      sourceConversation: deps.sourceConversation,
    });
    let artifacts: TelosArtifactStore | undefined;
    try {
      artifacts = new TelosArtifactStore(path);
      return await action(work, artifacts);
    } finally {
      artifacts?.close();
      work.close();
    }
  }
  function reviewedSourceReader(
    request: TelosWorkRoleRequest,
    work: TelosWorkStore,
    artifacts: TelosArtifactStore,
    itemId: string,
  ) {
    const capture = new TelosSourceCapture({
      events: deps.events,
      work,
      artifacts,
      assertAuthorized: () => {
        request.signal.throwIfAborted();
        request.assertAuthorized();
      },
      authorizeSource: (_actor, id) => (deps.sourceConversation ?? deps.ordinaryConversation)(id),
      authorizeArtifact: (_actor, id) => artifacts.userUploadAllowed(id),
    });
    const actor = structuredClone(request.actor);
    return (snapshotId: string) => capture.read(itemId, snapshotId, actor);
  }
  function setupWithPresentation(
    request: TelosWorkRoleRequest,
    presentationRef: TelosWorkRolePresentationRef | null,
    ordinary = false,
  ) {
    const actor = structuredClone(request.actor);
    const input = (
      ordinary ? TelosOrdinaryWorkRoleSetupInputSchema : TelosWorkRoleSetupInputSchema
    ).parse(structuredClone(request.raw));
    const selection = TelosWorkRoleContextSelectionSchema.parse(input.contextSelection);
    input.contextSelection = selection;
    renderTelosWorkRoleContext(selection);
    return usingStores(request, async (work, artifacts) => {
      const prepare = (
        reviewIsCurrent?: () => boolean,
        ref?: TelosWorkRolePresentationRef | null,
      ) =>
        ordinary
          ? work.prepareOrdinaryRoleSetup(input, actor, reviewIsCurrent, ref)
          : work.prepareRoleSetup(input, actor, reviewIsCurrent, ref);
      const authorize = async (scope: SetupScope, signal: AbortSignal) => {
        if (ordinary) {
          if (!deps.ordinary)
            throw new TelosWorkError('invalid', 'Ordinary workspace role setup is unavailable');
          await deps.ordinary.authorizeSettings(
            {
              actor: scope.actor,
              setup: TelosOrdinaryWorkRoleSetupIntentSchema.parse(scope.setup),
            },
            signal,
          );
        } else
          await deps.authorizeSettings(
            { actor: scope.actor, setup: TelosWorkRoleSetupIntentSchema.parse(scope.setup) },
            signal,
          );
      };
      if (ordinary && !work.roleSetupRequestRetained(input.requestId)) {
        // Validate the canonical review before even resolving an execution choice.
        const current = reviewTelosWorkRoleContext({
          work,
          artifacts,
          readReviewedSource: reviewedSourceReader(request, work, artifacts, input.itemId),
          actor,
          itemId: input.itemId,
          role: input.role,
          advisorPurpose: selection.advisorPurpose,
          selectedSourceSnapshotIds: selection.sources.map((source) => source.snapshotId),
          selectedArtifactRefs: selection.artifacts,
        });
        if (
          input.expectedRevision !== selection.brief.revision ||
          !isDeepStrictEqual(current, selection)
        )
          prepare(() => false, presentationRef); // Existing immutable terminal rejection proof; never an allocation intent.
        try {
          request.signal.throwIfAborted();
          request.assertAuthorized();
          if (!deps.ordinary)
            throw new TelosWorkError('invalid', 'Ordinary workspace role setup is unavailable');
          const selected = await deps.ordinary.resolveSelection(
            { actor, input: TelosOrdinaryWorkRoleSetupInputSchema.parse(input) },
            request.signal,
          );
          const { assertAgentToolRoute } = await import('./agent-tool-selection.js');
          request.signal.throwIfAborted();
          request.assertAuthorized();
          assertAgentToolRoute(selected.agentProfile.definition, 'codex-owned-local');
          await deps.workspaces().qualifyOrdinaryWorkspace({
            ...selected,
            preparationId:
              TelosOrdinaryWorkRoleSetupInputSchema.parse(input).settings.workspace.preparationId,
            settings: TelosOrdinaryWorkRoleSetupInputSchema.parse(input).settings,
            signal: request.signal,
          });
          request.signal.throwIfAborted();
          request.assertAuthorized();
        } catch {
          request.signal.throwIfAborted();
          request.assertAuthorized();
          // The complete reviewed request is ineligible before allocation. Journal
          // that terminal rejection through the existing owner, not an HTTP guess.
          try {
            prepare(() => false, presentationRef);
          } catch (error) {
            if (
              error instanceof TelosWorkError &&
              error.recovery?.outcome === 'rejected_before_allocation'
            )
              throw new TelosWorkError(
                'conflict',
                'This ordinary workspace selection is unavailable. Choose a supported local Codex account, model, thinking and agent, then review again.',
                error.recovery,
              );
            throw error;
          }
          throw new TelosWorkError(
            'conflict',
            'Recover the original ordinary role request before changing its selection',
          );
        }
      }

      const assertScope = (scope: SetupScope) => {
        request.signal.throwIfAborted();
        request.assertAuthorized();
        if (
          !isDeepStrictEqual(scope.actor, actor) ||
          scope.setup.actorId !== `operator:${actor.id}` ||
          !isDeepStrictEqual(scope.setup.input, input) ||
          selection.itemId !== input.itemId ||
          selection.role !== input.role
        )
          throw new TelosWorkError('unauthorized', 'Role setup scope changed');
        const saved = prepare(undefined, presentationRef);
        const current = reviewTelosWorkRoleContext({
          work,
          artifacts,
          readReviewedSource: reviewedSourceReader(request, work, artifacts, input.itemId),
          actor,
          itemId: input.itemId,
          role: saved.receipt && input.role === 'worker' ? 'lead' : input.role,
          // A committed replay requalifies retained material/privacy; it does
          // not request a new child advisor under the item's current kind.
          // The original immutable purpose and receipt remain unchanged.
          advisorPurpose: saved.receipt ? undefined : selection.advisorPurpose,
          selectedSourceSnapshotIds: selection.sources.map((source) => source.snapshotId),
          selectedArtifactRefs: selection.artifacts,
        });
        if (!saved.receipt) {
          if (
            input.expectedRevision !== selection.brief.revision ||
            !isDeepStrictEqual(current, selection)
          )
            throw new TelosWorkError('conflict', 'Reviewed work context changed');
        } else {
          // Exact completed receipts retain their old brief and ancestor pins.
          // Requalify selected immutable material and its original item scopes.
          if (
            !isDeepStrictEqual(current.sources, selection.sources) ||
            !isDeepStrictEqual(current.artifacts, selection.artifacts)
          )
            throw new TelosWorkError('unauthorized', 'Retained role material changed');
          for (const itemId of [
            ...selection.parentCriteria.map((parent) => parent.itemId),
            selection.overallGoal.itemId,
          ]) {
            if (/^life[-_ ]?ops$/i.test(work.readSourceTarget(itemId, actor).record.profile))
              throw new TelosWorkError('unauthorized', 'Retained role context unavailable');
          }
          if (
            selection.leadConversationId &&
            !deps.ordinaryConversation(selection.leadConversationId)
          )
            throw new TelosWorkError('unauthorized', 'Retained outcome lead unavailable');
        }
      };
      const retained = prepare(() => {
        request.signal.throwIfAborted();
        request.assertAuthorized();
        if (selection.itemId !== input.itemId || selection.role !== input.role)
          throw new TelosWorkError('unauthorized', 'Role setup scope changed');
        const current = reviewTelosWorkRoleContext({
          work,
          artifacts,
          readReviewedSource: reviewedSourceReader(request, work, artifacts, input.itemId),
          actor,
          itemId: input.itemId,
          role: input.role,
          advisorPurpose: selection.advisorPurpose,
          selectedSourceSnapshotIds: selection.sources.map((source) => source.snapshotId),
          selectedArtifactRefs: selection.artifacts,
        });
        request.signal.throwIfAborted();
        request.assertAuthorized();
        return (
          input.expectedRevision === selection.brief.revision &&
          isDeepStrictEqual(current, selection)
        );
      }, presentationRef);
      const initial = { actor, setup: retained.setup };
      assertScope(initial);
      await authorize(structuredClone(initial), request.signal);
      assertScope(initial);
      if (retained.receipt && !ordinary) return retained.receipt;
      const common = {
        work,
        events: deps.events,
        workspaces: deps.workspaces(),
        authorize: async (scope: SetupScope, signal: AbortSignal) => {
          assertScope(scope);
          await authorize(structuredClone(scope), signal);
          assertScope(scope);
        },
        assertBeforeApply: (scope: SetupScope) => assertScope(scope),
        retainContext: async (
          scope: SetupScope & { conversationId: string },
          signal: AbortSignal,
        ) => {
          assertScope(scope);
          signal.throwIfAborted();
          const session = deps.events.getSession(scope.conversationId);
          if (!session?.accountBinding || !deps.ordinaryConversation(scope.conversationId))
            throw new TelosWorkError('unauthorized', 'Prepared ordinary role session unavailable');
          retainTelosWorkRoleContext(
            deps.events,
            scope.conversationId,
            session.accountBinding,
            selection,
          );
          const presentation = ordinary
            ? work.rolePresentationForOrdinarySetup(input, actor)
            : work.rolePresentationForSetup(input, actor);
          if (presentation)
            retainTelosWorkRolePresentation(
              deps.events,
              scope.conversationId,
              session.accountBinding,
              presentation,
            );
          assertScope(scope);
        },
      };
      const owner = ordinary
        ? new (await import('./telos-ordinary-work-role-setup.js')).TelosOrdinaryWorkRoleSetup({
            ...common,
            resolveSelection: deps.ordinary!.resolveSelection,
          })
        : new TelosWorkRoleSetup({ ...common, resolvePreparation: deps.resolvePreparation });
      // Execution-only imports may yield; preserve the original authority fence.
      assertScope(initial);
      return owner.setup(actor, input, request.signal);
    });
  }
  return {
    context(request) {
      const actor = structuredClone(request.actor);
      const input = ReviewInput.parse(structuredClone(request.raw));
      return usingStores(request, async (work, artifacts) => {
        const selection = reviewTelosWorkRoleContext({
          work,
          artifacts,
          readReviewedSource: reviewedSourceReader(request, work, artifacts, input.itemId),
          actor,
          itemId: input.itemId,
          role: input.role,
          advisorPurpose: input.advisorPurpose,
          selectedSourceSnapshotIds: input.sourceSnapshotIds,
          selectedArtifactRefs: input.artifactRefs,
        });
        request.signal.throwIfAborted();
        request.assertAuthorized();
        return selection;
      });
    },
    review(request) {
      const actor = structuredClone(request.actor);
      const input = ReviewInput.parse(structuredClone(request.raw));
      return usingStores(request, async (work, artifacts) =>
        work.reviewRolePresentation(actor, () => {
          request.signal.throwIfAborted();
          request.assertAuthorized();
          const selected = {
            work,
            artifacts,
            actor,
            readReviewedSource: reviewedSourceReader(request, work, artifacts, input.itemId),
            itemId: input.itemId,
            role: input.role,
            advisorPurpose: input.advisorPurpose,
            selectedSourceSnapshotIds: input.sourceSnapshotIds,
            selectedArtifactRefs: input.artifactRefs,
          };
          const selection = reviewTelosWorkRoleContext(selected);
          const presentation = captureTelosWorkRolePresentation(selected, selection);
          request.signal.throwIfAborted();
          request.assertAuthorized();
          return { selection, presentation };
        }),
      );
    },
    setupOrdinary(request) {
      return setupWithPresentation(request, null, true);
    },
    setupReviewedOrdinary(request) {
      const reviewed = TelosOrdinaryWorkReviewedRoleSetupInputSchema.parse(
        structuredClone(request.raw),
      );
      return setupWithPresentation(
        { ...request, raw: reviewed.input },
        reviewed.presentationRef,
        true,
      );
    },
    setup(request) {
      return setupWithPresentation(request, null);
    },
    setupReviewed(request) {
      const reviewed = TelosWorkReviewedRoleSetupInputSchema.parse(structuredClone(request.raw));
      return setupWithPresentation({ ...request, raw: reviewed.input }, reviewed.presentationRef);
    },
  };
}
