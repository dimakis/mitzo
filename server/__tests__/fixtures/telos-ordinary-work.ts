import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownedOrdinaryRuntimeFixture } from './owned-ordinary-workspace-runtime.js';
import { createTelosCanonicalData } from './telos-canonical-advisor.js';
import { TelosWorkStore } from '../../telos-work-store.js';
import { TelosOrdinaryWorkRoleSetup } from '../../telos-ordinary-work-role-setup.js';
import { reviewTelosWorkRoleContext } from '../../telos-work-role-review.js';
import { isAvailableTelosWorkConversation } from '../../telos-work-conversation.js';
import { retainTelosWorkRoleContext } from '../../telos-work-role-context.js';
import { isAuthSessionCurrent } from '../../auth.js';
export async function createTelosOrdinaryWorkFixture(
  cleanup: Array<() => void | Promise<void>>,
  role: 'advisor' | 'lead' | 'worker' = 'lead',
) {
  const native = await ownedOrdinaryRuntimeFixture(cleanup),
    canonical = createTelosCanonicalData();
  cleanup.push(() => canonical.close());
  const openWork = () =>
    new TelosWorkStore(canonical.dbPath, {
      ordinaryConversation: (id) =>
        isAvailableTelosWorkConversation(native.events.getSession(id)) || id === 'planning',
    });
  let work = openWork();
  cleanup.push(() => work.close());
  const { actor, artifacts, db } = canonical;
  work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: 'kind',
      expectedRevision: work.read('studio', actor).revision,
      kind: 'outcome',
    },
    actor,
  );
  if (role === 'worker') {
    const conversation = {
      namespace: 'mitzo' as const,
      conversationId: native.first.receipt.sessionId,
    };
    work.execute(
      {
        operation: 'link',
        itemId: 'studio',
        requestId: 'lead-link',
        expectedRevision: work.read('studio', actor).revision,
        role: 'lead',
        conversation,
      },
      actor,
    );
    work.execute(
      {
        operation: 'assign',
        itemId: 'studio',
        requestId: 'lead-assign',
        expectedRevision: work.read('studio', actor).revision,
        role: 'lead',
        conversationId: conversation.conversationId,
        expectedAssignmentRevision: 0,
      },
      actor,
    );
  }
  const contextSelection = reviewTelosWorkRoleContext({
    work,
    artifacts,
    actor,
    itemId: 'studio',
    role,
    advisorPurpose: role === 'advisor' ? 'refine' : undefined,
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [
      {
        artifactId: canonical.material.id,
        revision: canonical.material.revision,
        sha256: canonical.material.sha256,
      },
    ],
  });
  const input = {
    version: 2 as const,
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: contextSelection.brief.revision,
    role,
    expectedAssignmentRevision: role === 'advisor' ? null : 0,
    contextSelection,
    settings: native.first.receipt.settings,
  };
  let requiredCapabilities: readonly string[] = ['ordinary_conversation', 'retained_artifacts'];
  const assertAuthorized = () => {
    if (!isAuthSessionCurrent(native.auth)) throw Error('Revoked private operator');
  };
  const createOwner = () =>
    new TelosOrdinaryWorkRoleSetup({
      work,
      events: native.events,
      workspaces: native.workspaces,
      resolveSelection: async (scope) => {
        assertAuthorized();
        expect(scope.actor).toEqual(actor);
        const profile = native.library.version(
          'user',
          scope.input.settings.selection.agent.profileId,
          scope.input.settings.selection.agent.revision,
        );
        if (!profile) throw Error('Published agent unavailable');
        return {
          binding: native.binding,
          agentProfile: profile,
          taskRoot: native.taskRoot,
          requiredCapabilities,
        };
      },
      authorize: async (scope) => {
        assertAuthorized();
        expect(scope.setup.input).toEqual(input);
      },
      assertBeforeApply: () => assertAuthorized(),
      retainContext: async (scope) => {
        const session = native.events.getSession(scope.conversationId);
        if (!session?.accountBinding) throw Error('Original ordinary account unavailable');
        retainTelosWorkRoleContext(
          native.events,
          scope.conversationId,
          session.accountBinding,
          contextSelection,
        );
      },
    });
  return {
    native,
    canonical,
    get work() {
      return work;
    },
    actor,
    db,
    input,
    get owner() {
      return createOwner();
    },
    restart: () => {
      work.close();
      work = openWork();
    },
    unsupported: () => {
      requiredCapabilities = ['git_revision'];
    },
  };
}
