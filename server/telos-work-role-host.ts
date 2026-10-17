import { isDeepStrictEqual } from 'node:util';
import {
  TelosWorkRoleSetupInputSchema,
  TelosWorkRoleContextRequestSchema,
  type TelosWorkCommandReceipt,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { TelosWorkRoleSetup, type TelosWorkRoleSetupScope } from './telos-work-role-setup.js';
import type { TelosWorkRoleRequest } from './telos-work-routes.js';
import {
  TelosWorkRoleContextSelectionSchema,
  retainTelosWorkRoleContext,
  renderTelosWorkRoleContext,
  type TelosWorkRoleContextSelection,
} from './telos-work-role-context.js';
import { TelosWorkStore, TelosWorkError } from './telos-work-store.js';
import { TelosArtifactStore } from './telos-artifact-store.js';
import { reviewTelosWorkRoleContext } from './telos-work-role-review.js';
import { TelosSourceCapture } from './telos-source-capture.js';

type SetupDependencies = ConstructorParameters<typeof TelosWorkRoleSetup>[0];
export interface TelosWorkRoleHostDependencies {
  dbPath(): string;
  events: EventStore;
  ordinaryConversation(id: string): boolean;
  sourceConversation?(id: string): boolean;
  workspaces(): RepositoryWorkspaces;
  resolvePreparation: SetupDependencies['resolvePreparation'];
  authorizeSettings: SetupDependencies['authorize'];
}
const ReviewInput = TelosWorkRoleContextRequestSchema;

export function createTelosWorkRoleHost(deps: TelosWorkRoleHostDependencies): {
  context(request: TelosWorkRoleRequest): Promise<TelosWorkRoleContextSelection>;
  setup(request: TelosWorkRoleRequest): Promise<TelosWorkCommandReceipt>;
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
    setup(request) {
      const actor = structuredClone(request.actor);
      const input = TelosWorkRoleSetupInputSchema.parse(structuredClone(request.raw));
      const selection = TelosWorkRoleContextSelectionSchema.parse(input.contextSelection);
      input.contextSelection = selection;
      renderTelosWorkRoleContext(selection);
      return usingStores(request, async (work, artifacts) => {
        const assertScope = (scope: TelosWorkRoleSetupScope) => {
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
          const saved = work.prepareRoleSetup(input, actor);
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
        const retained = work.prepareRoleSetup(input, actor);
        const initial = { actor, setup: retained.setup };
        assertScope(initial);
        await deps.authorizeSettings(structuredClone(initial), request.signal);
        assertScope(initial);
        if (retained.receipt) return retained.receipt;
        const owner = new TelosWorkRoleSetup({
          work,
          events: deps.events,
          workspaces: deps.workspaces(),
          authorize: async (scope, signal) => {
            assertScope(scope);
            await deps.authorizeSettings(structuredClone(scope), signal);
            assertScope(scope);
          },
          assertBeforeApply: (scope) => assertScope(scope),
          resolvePreparation: deps.resolvePreparation,
          retainContext: async (scope, signal) => {
            assertScope(scope);
            signal.throwIfAborted();
            const session = deps.events.getSession(scope.conversationId);
            if (!session?.accountBinding || !deps.ordinaryConversation(scope.conversationId))
              throw new TelosWorkError(
                'unauthorized',
                'Prepared ordinary role session unavailable',
              );
            retainTelosWorkRoleContext(
              deps.events,
              scope.conversationId,
              session.accountBinding,
              selection,
            );
            assertScope(scope);
          },
        });
        return owner.setup(actor, input, request.signal);
      });
    },
  };
}
