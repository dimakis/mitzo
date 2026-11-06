import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';
import { EventStore } from '../event-store.js';
import { createApplicationCollaborationJoining } from '../collaboration-application-joining.js';
import {
  fixture,
  cleanups,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.SYMPOSIUM_OFFLINE_HOME ?? os.homedir() };
});
// Substitute only the external runtime declaration and account readiness probe.
// Actual workspace/source, preparation, review and joining owners remain in use.
vi.mock('../ordinary-openshell-codex-entry-owner.js', async (original) => {
  const { ordinaryOpenShellCodexTarget } = await import('../ordinary-openshell-codex-route.js');
  const config = {
    cli: '/offline/openshell',
    image: 'offline',
    policy: '/offline/policy',
    seed: '/offline/seed',
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'workspace',
    gateway: 'gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 13,
    workdir: '/sandbox/workspaces/task',
    webSearch: 'disabled' as const,
  };
  const target = ordinaryOpenShellCodexTarget({
    targetId: 'offline-shell',
    runtimeContractRevision: 'offline-contract',
    config,
    openaiApi: 'disabled',
  });
  return {
    ...(await original<object>()),
    loadOrdinaryOpenShellCodexTarget: () => ({
      config,
      target,
      deploymentRevision: 'offline-deployment',
    }),
  };
});
afterEach(cleanupApplicationReviewFixtures);

it.each(['none', 'after reservation', 'after receipt', 'revoked grant after receipt'] as const)(
  'silently joins an OpenShell reservation and retains its allocation across %s interruption',
  async (crash) => {
    for (const key of [
      'CODEX_HOME',
      'MITZO_KEYCHAIN_HELPER',
      'MITZO_KEYCHAIN_CONNECTIONS_DIR',
      'MITZO_KNOWLEDGE_LIBRARY_CONFIG',
      'MITZO_WORKSPACE_RUNTIME_CONFIG',
    ])
      vi.stubEnv(key, undefined);
    vi.spyOn(OpenShellRuntimeManager.prototype, 'verifySubscriptionSignIn').mockImplementation(
      async () => Date.now() + 60000,
    );
    const f = await fixture({ runOn: 'openshell' });
    vi.stubEnv('SYMPOSIUM_OFFLINE_HOME', join(f.root, 'home'));
    vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', join(f.root, 'tasks'));
    const reviewed = await f.review();
    expect(reviewed.snapshot.capacity.status).toBe('unverified');
    const input = {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      name: 'Reviewer',
      settings: reviewed.settings,
      snapshot: { snapshotId: reviewed.snapshot.snapshotId, sha256: reviewed.snapshot.sha256 },
    };
    let store = f.store;
    let joining = createApplicationCollaborationJoining({ ...f, store }, f.auth);
    let joined;
    if (crash === 'none')
      joined = await joining.confirm(f.auth.id, f.group, input, f.controller.signal);
    else {
      const interrupted =
        crash === 'after reservation'
          ? vi.spyOn(store, 'prepareOrdinarySession')
          : vi.spyOn(store.collaborationConversation, 'recordAllocation');
      interrupted.mockImplementationOnce(() => {
        throw Error('Simulated allocation crash');
      });
      await expect(joining.confirm(f.auth.id, f.group, input, f.controller.signal)).rejects.toThrow(
        'Simulated allocation crash',
      );
      interrupted.mockRestore();
      const pending = store.collaborationConversation.view(f.group).joins[0];
      const receipt = store.getOrdinarySessionPreparation(pending.allocationOperationId);
      expect(!!receipt).toBe(crash !== 'after reservation');
      store.close();
      store = new EventStore(join(f.root, '.mitzo', 'events.db'));
      cleanups.push(() => store.close());
      joining = createApplicationCollaborationJoining({ ...f, store }, f.auth);
      if (crash === 'revoked grant after receipt') {
        f.access.mockRejectedValue(Error('Repository grant revoked'));
        await expect(
          joining.recover(f.auth.id, f.group, pending.joinId, f.controller.signal),
        ).rejects.toThrow('Repository grant revoked');
        expect(store.collaborationConversation.getJoin(f.group, pending.joinId)).toEqual(pending);
        expect(store.getSessionCollaboration(f.group)?.participantSessionIds).toEqual(['source']);
        f.access.mockResolvedValue({ revision: 1, allowedBaseBranches: ['main'] });
      }
      joined = await joining.recover(f.auth.id, f.group, pending.joinId, f.controller.signal);
      expect(joined.allocationOperationId).toBe(pending.allocationOperationId);
      if (receipt) expect(joined.sessionId).toBe(receipt.sessionId);
    }
    expect(joined.state).toBe('linked');
    expect(f.workspaces.get(input.settings.repositoryWorkspaceId)).toMatchObject({
      state: 'ready',
      ordinaryFirstReservation: { conversationId: joined.sessionId },
    });
    expect(f.workspaces.get(input.settings.repositoryWorkspaceId).conversationId).toBeUndefined();
    expect(store.getOrdinaryInitialCommandId(joined.sessionId!)).toBeUndefined();
    expect(store.getSessionEvents(joined.sessionId!)).toEqual([]);
    expect(store.listSessions()).toHaveLength(2);
    expect(await joining.confirm(f.auth.id, f.group, input, f.controller.signal)).toEqual(joined);
    expect(await joining.recover(f.auth.id, f.group, joined.joinId, f.controller.signal)).toEqual(
      joined,
    );
  },
);
