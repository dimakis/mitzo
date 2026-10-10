import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { SymposiumOrchestrator } from '../symposium-orchestrator.js';
import { createOutputContributors } from '../output-contributors.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import type { OrdinaryChatPort } from '../symposium-ordinary-turn.js';

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((f) => f());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'output-contributors-'));
  dirs.push(root);
  const databasePath = join(root, 'events.db');
  const store = new EventStore(databasePath);
  cleanup.push(() => store.close());
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo', cwd: root });
  store.append('source', 'message_start', { messageId: 'draft' });
  store.append('source', 'block_start', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'block_delta', {
    messageId: 'draft',
    blockId: 'text',
    delta: 'Selected draft',
  });
  store.append('source', 'block_end', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'message_end', { messageId: 'draft' });
  const candidate = store.listSessionOutputCandidates('source')[0];
  const output = store.registerSessionOutput('source', {
    requestId: 'keep',
    title: 'Draft',
    source: candidate.source,
  });
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: join(root, 'account'),
        email: 'offline@example.invalid',
        planType: 'plus',
        models: [{ id: 'offline-model', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  let turn = 0;
  const port: OrdinaryChatPort = {
    startChat: vi.fn(async (transport, _client, _prompt, options) => {
      const id = options.resume ?? options.initialSessionId!;
      store.upsertSession({
        sessionId: id,
        conversationSource: 'mitzo',
        cwd: root,
        accountBinding: profiles.resolve('personal', 'offline-model'),
      });
      options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
      options.ordinaryTurnLifecycle!.accepted(options.clientMsgId!, 'raw-thread', `turn-${++turn}`);
      transport.send({
        type: 'block_start',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
      });
      transport.send({
        type: 'block_delta',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        delta: 'Contributor reply',
      });
      options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, `turn-${turn}`, 'completed');
      options.onTurnResult?.({});
    }),
    stopChat: vi.fn(),
  };
  const deps = {
    store,
    databasePath,
    currentAccounts: () => profiles,
    port,
    workspaceForSession: (id: string) => (id === 'source' ? { cwd: root } : null),
    resolveProfile: vi.fn(async () => null),
    readMessages: vi.fn(async () => []),
  };
  const service = createOutputContributors(deps);
  cleanup.unshift(() => service.close());
  const input = {
    requestId: 'add',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: outputContextPackageDigest('source', output),
    accountId: 'personal',
    model: 'offline-model',
    label: 'Contributor',
    instructions: 'Help improve the selected draft.',
    mode: 'ask' as const,
  };
  return { service, store, deps, input, port, output };
}
describe('ordinary contributors to registered outputs', () => {
  it('targets the exact live child turn and reports idle only after terminal and query closure', async () => {
    const { service, input, port, store } = setup();
    const interrupted = vi.fn();
    vi.mocked(port.startChat).mockImplementation(
      async (_transport, _clientId, _prompt, options) => {
        const id = options.initialSessionId!;
        store.upsertSession({ sessionId: id, conversationSource: 'mitzo' });
        await new Promise<void>((resolve) => {
          options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
          options.ordinaryTurnLifecycle!.accepted(options.clientMsgId!, 'raw-thread', 'live-turn');
          options.onQueryReady?.({
            interrupt: async () => {
              interrupted();
              options.ordinaryTurnLifecycle!.terminal(
                options.clientMsgId!,
                'live-turn',
                'interrupted',
              );
              options.onTurnResult?.({});
              resolve();
            },
          });
        });
      },
    );
    const contributor = await service.add('source', input);
    const completion = service.message('source', contributor.id, {
      requestId: 'live-request',
      text: 'Continue',
    });
    await vi.waitFor(() =>
      expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() => expect(port.startChat).toHaveBeenCalledTimes(1));
    const stopped = await service.stop('source', contributor.id, { requestId: 'stop-exact-turn' });
    expect(interrupted).toHaveBeenCalledTimes(1);
    expect(stopped.status).toBe('idle');
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
      0,
    );
    expect((await completion).delivery.status).toBe('cancelled');
  });
  it('fences unknown retained execution on reload and rechecks cancelled unsettled cleanup on repeated Stop', async () => {
    const { service, deps, input, port, store } = setup();
    vi.mocked(port.startChat).mockImplementation(
      async (_transport, _clientId, _prompt, options) => {
        const id = options.initialSessionId!;
        store.upsertSession({ sessionId: id, conversationSource: 'mitzo' });
        options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
        options.ordinaryTurnLifecycle!.accepted(
          options.clientMsgId!,
          'raw-thread',
          'retained-turn',
        );
        await new Promise<void>(() => {});
      },
    );
    const contributor = await service.add('source', input);
    void service
      .message('source', contributor.id, { requestId: 'unfinished-turn', text: 'Continue' })
      .catch(() => {});
    await vi.waitFor(() =>
      expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() => expect(port.startChat).toHaveBeenCalledTimes(1));
    await expect(
      service.message('source', contributor.id, {
        requestId: 'competing-turn',
        text: 'Another request',
      }),
    ).rejects.toThrow('active');
    expect(store.getSymposiumDeliveries(contributor.id)).toHaveLength(1);
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    const stopped = await reopened.stop('source', contributor.id, { requestId: 'stop-one' });
    expect(stopped.status).toBe('stopping');
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
      1,
    );
    const reconcile = vi.spyOn(SymposiumOrchestrator.prototype, 'reconcileDeliveryCleanup');
    expect(
      (await reopened.stop('source', contributor.id, { requestId: 'stop-again' })).status,
    ).toBe('stopping');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(port.startChat).toHaveBeenCalledTimes(1);
    await expect(
      reopened.message('other', contributor.id, { requestId: 'wrong-owner', text: 'Write' }),
    ).rejects.toThrow('not found');
  });
  it('recovers an allocation interrupted after membership but before exact admission', async () => {
    const { service, deps, store, input, port } = setup();
    vi.spyOn(store, 'recordSymposiumAdmission').mockImplementationOnce(() => {
      throw new Error('Simulated admission interruption');
    });
    await expect(service.add('source', input)).rejects.toThrow('interruption');
    const id = store.getOutputContributorBindings('source')[0].coordinatorSessionId;
    expect(store.getLatestSymposiumMembership(id, 'contributor')?.reconciliation).not.toBe(
      'confirmed',
    );
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    const recovered = await reopened.add('source', input);
    expect(recovered.id).toBe(id);
    expect(store.getLatestSymposiumMembership(id, 'contributor')?.reconciliation).toBe('confirmed');
    expect(port.startChat).not.toHaveBeenCalled();
  });

  it('recovers saved-profile draft activation with exact lookup while preserving separate label and additional user guidance', async () => {
    const { service, deps, store, input, port } = setup();
    const definition = {
      name: 'Saved writer',
      role: 'coder' as const,
      instructions: 'Use the selected material.',
      expectedOutput: 'Draft',
      acceptanceCriteria: ['Be precise'],
      modelPolicyRole: 'coder',
    };
    const profile = {
      profileId: 'writer',
      revision: 1,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    Object.assign(deps, { resolveProfile: vi.fn(async () => profile) });
    const selected = {
      ...input,
      instructions: 'Respond briefly.',
      profileSelection: { profileId: 'writer', revision: 1 },
    };
    const commit = store.setSymposiumConfig.bind(store);
    vi.spyOn(store, 'setSymposiumConfig')
      .mockImplementationOnce(commit)
      .mockImplementationOnce(() => {
        throw new Error('Simulated draft activation interruption');
      });
    await expect(service.add('source', selected, 'authenticated-transport')).rejects.toThrow(
      'interruption',
    );
    const id = store.getOutputContributorBindings('source')[0].coordinatorSessionId;
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    const recovered = await reopened.add('source', selected, 'authenticated-transport');
    expect(recovered).toMatchObject({ id, label: input.label });
    expect(deps.resolveProfile).toHaveBeenLastCalledWith(
      selected.profileSelection,
      'authenticated-transport',
    );
    await reopened.message('source', id, { requestId: 'profile-turn', text: 'Write' });
    const guidance = vi.mocked(port.startChat).mock.calls[0][3].contributorGuidance;
    expect(guidance).toContain(definition.instructions);
    expect(guidance).toContain('Additional user guidance');
    expect(guidance).toContain('Respond briefly.');
  });

  it('fences source loss and workspace loss, and checks uniqueness outside the bounded list projection', async () => {
    const { service, deps, store, input, port } = setup();
    const contributor = await service.add('source', input);
    const db = new Database(deps.databasePath);
    for (let i = 0; i < 101; i++)
      store.append('source', 'output_contributor_created', {
        ...store.getOutputContributorBindings('source')[0],
        coordinatorSessionId: `irrelevant-${i}`,
        outputId: '00000000-0000-4000-8000-000000000000',
      });
    expect(
      store
        .getOutputContributorBindings('source')
        .some((value) => value.coordinatorSessionId === contributor.id),
    ).toBe(false);
    await expect(service.add('source', { ...input, requestId: 'another' })).rejects.toThrow(
      'already has',
    );
    Object.assign(deps, { workspaceForSession: () => null });
    await expect(
      service.message('source', contributor.id, { requestId: 'lost-workspace', text: 'Write' }),
    ).rejects.toThrow('workspace');
    Object.assign(deps, { workspaceForSession: () => ({ cwd: 'existing' }) });
    db.prepare("DELETE FROM events WHERE type='block_delta'").run();
    await expect(
      service.message('source', contributor.id, { requestId: 'lost-source', text: 'Write' }),
    ).rejects.toThrow('unavailable');
    expect(port.startChat).not.toHaveBeenCalled();
    db.close();
  });
  it('allocates an independent coordinator idempotently without starting providers or changing the source session', async () => {
    const { service, store, deps, input, port } = setup();
    const first = await service.add('source', input);
    expect(first).toMatchObject({
      label: 'Contributor',
      outputId: input.outputId,
      status: 'idle',
      sessionId: null,
    });
    expect((await service.add('source', input)).id).toBe(first.id);
    expect(port.startChat).not.toHaveBeenCalled();
    expect(store.getSession('source')?.symposiumConfig).toBeNull();
    expect(store.getSession(first.id)?.sessionType).toBe('symposium');
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    expect((await reopened.list('source')).contributors.map((c) => c.id)).toEqual([first.id]);
    expect((await reopened.add('source', input)).id).toBe(first.id);
    await expect(reopened.add('source', { ...input, label: 'Changed' })).rejects.toThrow();
  });
  it('dispatches only selected source, preserves child followup and durable attributed replies across reload', async () => {
    const { service, deps, input, port } = setup();
    const contributor = await service.add('source', input);
    const first = await service.message('source', contributor.id, {
      requestId: 'turn-one',
      text: 'Improve this',
    });
    expect(first.delivery.status).toBe('delivered');
    expect(first.contributor.messages[0]).toMatchObject({
      role: 'assistant',
      symposiumProvenance: { accountBinding: { accountId: 'personal', model: 'offline-model' } },
    });
    const calls = vi.mocked(port.startChat).mock.calls;
    expect(calls[0][2]).toContain('Selected draft');
    expect(calls[0][2]).not.toContain('source session history');
    expect(calls[0][3].mode).toBe('ask');
    const child = first.contributor.sessionId;
    expect(child).not.toBe('source');
    await service.message('source', contributor.id, { requestId: 'turn-two', text: 'Continue' });
    expect(calls[1][3].resume).toBe(child);
    await service.message('source', contributor.id, {
      requestId: 'turn-one',
      text: 'Improve this',
    });
    expect(port.startChat).toHaveBeenCalledTimes(2);
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    expect((await reopened.list('source')).contributors[0].messages).toHaveLength(2);
  });
  it('rejects wrong output scope/digest and unresolved saved profiles before allocating authority', async () => {
    const { service, input, store, deps } = setup();
    await expect(
      service.add('source', { ...input, contextPackageDigest: '0'.repeat(64) }),
    ).rejects.toThrow();
    await expect(
      service.add('source', { ...input, profileSelection: { profileId: 'missing', revision: 1 } }),
    ).rejects.toThrow();
    expect(deps.resolveProfile).toHaveBeenCalled();
    expect(store.getOutputContributorBindings('source')).toEqual([]);
    await expect(service.add('unknown', input)).rejects.toThrow();
    store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
    await expect(service.add('other', input)).rejects.toThrow();
  });
});
