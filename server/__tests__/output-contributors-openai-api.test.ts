import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import { createOutputContributors } from '../output-contributors.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import type { OrdinaryChatPort } from '../symposium-ordinary-turn.js';

const cleanup: (() => void)[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (key.startsWith('MITZO_OPENSHELL_') || key.startsWith('MITZO_KNOWLEDGE_'))
      vi.stubEnv(key, undefined);
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'offline-image');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/offline/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/offline/seed');
});
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(sandboxProvider = 'offline-api') {
  const root = mkdtempSync(join(tmpdir(), 'output-api-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, 'events.db');
  const store = new EventStore(databasePath);
  cleanup.push(() => store.close());
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo', cwd: root });
  store.append('source', 'message_start', { messageId: 'draft' });
  store.append('source', 'block_start', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'block_delta', {
    messageId: 'draft',
    blockId: 'text',
    delta: 'Selected exact draft',
  });
  store.append('source', 'block_end', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'message_end', { messageId: 'draft' });
  const output = store.registerSessionOutput('source', {
    requestId: 'register',
    title: 'Draft',
    source: store.listSessionOutputCandidates('source')[0].source,
  });
  const config = {
    id: 'api',
    label: 'Offline API',
    provider: 'openai' as const,
    credentialRef: { provider: 'offline', service: 'unused', account: 'api' },
    ...(sandboxProvider ? { sandboxProvider } : {}),
    models: [{ id: 'offline-model', label: 'Offline', reasoningEfforts: ['low'] }],
  };
  let profiles = new AccountProfiles([config]);
  let turn = 0;
  const port: OrdinaryChatPort = {
    stopChat: vi.fn(),
    startChat: vi.fn(async (_transport, _client, _prompt, options) => {
      const child = options.resume ?? options.initialSessionId!;
      const rawTurn = `offline-turn-${++turn}`;
      store.upsertSession({
        sessionId: child,
        conversationSource: 'mitzo',
        cwd: root,
        accountBinding: profiles.resolve(options.accountId!, options.model!),
      });
      store.append(child, 'contributor_execution', {
        ...options.contributorExecution,
        childSessionId: child,
      });
      options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
      options.ordinaryTurnLifecycle!.accepted(options.clientMsgId!, 'offline-thread', rawTurn);
      options.onQueryEvent!({
        type: 'block_start',
        sessionId: child,
        messageId: rawTurn,
        blockId: 'text',
        blockType: 'text',
      });
      options.onQueryEvent!({
        type: 'block_delta',
        sessionId: child,
        messageId: rawTurn,
        blockId: 'text',
        delta: 'Offline API reply',
      });
      options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, rawTurn, 'completed');
      options.onTurnResult?.({});
    }),
  };
  const service = createOutputContributors({
    store,
    databasePath,
    currentAccounts: () => profiles,
    port,
    workspaceForSession: (id) => (id === 'source' ? { cwd: root } : null),
    resolveProfile: async () => null,
  });
  cleanup.push(() => service.close());
  const input = {
    requestId: 'add',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: outputContextPackageDigest('source', output),
    accountId: 'api',
    model: 'offline-model',
    reasoningEffort: 'low',
    label: 'API contributor',
    instructions: 'Improve only the selected draft.',
    mode: 'agent' as const,
  };
  return {
    service,
    store,
    port,
    input,
    output,
    changeAccount: () => {
      profiles = new AccountProfiles([{ ...config, sandboxProvider: 'changed-api' }]);
    },
  };
}

describe('ordinary OpenAI API contributors through Codex/OpenShell', () => {
  it('admits two same-account contributors to one exact output with independent child history and directed replies', async () => {
    const { service, store, port, input } = setup();
    const parent = store.getSession('source');
    const first = await service.add('source', input);
    const secondInput = { ...input, requestId: 'add-second', label: 'Second writer' };
    const second = await service.add('source', secondInput);
    expect(second.id).not.toBe(first.id);
    expect((await service.add('source', secondInput)).id).toBe(second.id);
    expect(port.startChat).not.toHaveBeenCalled();
    const firstTurn = await service.message('source', first.id, {
      requestId: 'shared-id',
      text: 'First task',
    });
    const secondTurn = await service.message('source', second.id, {
      requestId: 'shared-id',
      text: 'Second task',
    });
    expect(firstTurn.delivery.status).toBe('delivered');
    expect(secondTurn.delivery.status).toBe('delivered');
    expect(secondTurn.contributor.sessionId).not.toBe(firstTurn.contributor.sessionId);
    await service.stop('source', first.id, { requestId: 'stop-first' });
    const continued = await service.message('source', second.id, {
      requestId: 'continue-second',
      text: 'Continue second task',
    });
    expect(continued.contributor.sessionId).toBe(secondTurn.contributor.sessionId);
    const calls = vi.mocked(port.startChat).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][2]).toContain('First task');
    expect(calls[1][2]).toContain('Second task');
    expect(calls[1][2]).not.toContain('First task');
    expect(calls[2][3].resume).toBe(secondTurn.contributor.sessionId);
    expect(calls.every((call) => call[3].accountId === 'api')).toBe(true);
    const listed = (await service.list('source')).contributors;
    expect(listed).toHaveLength(2);
    expect(listed.find((row) => row.id === first.id)?.messages).toHaveLength(1);
    expect(listed.find((row) => row.id === second.id)?.messages).toHaveLength(2);
    expect(store.getSession('source')).toEqual(parent);
  });

  it('lists and allocates the selected API account, directs exact output, resumes its independent child and deduplicates replay', async () => {
    const { service, store, port, input, output } = setup();
    const parent = store.getSession('source');
    expect((await service.list('source')).eligibility).toMatchObject({
      available: true,
      accountIds: ['api'],
    });
    const contributor = await service.add('source', input);
    expect((await service.add('source', input)).id).toBe(contributor.id);
    expect(port.startChat).not.toHaveBeenCalled();
    const first = await service.message('source', contributor.id, {
      requestId: 'first',
      text: 'Improve it',
    });
    expect(first.delivery.status).toBe('delivered');
    expect(first.contributor.messages[0]).toMatchObject({
      symposiumProvenance: {
        accountBinding: { accountId: 'api', provider: 'openai', model: input.model },
      },
    });
    const child = first.contributor.sessionId;
    expect(child).toBeTruthy();
    expect(child).not.toBe('source');
    expect(child).not.toBe(contributor.id);
    const second = await service.message('source', contributor.id, {
      requestId: 'second',
      text: 'Continue',
    });
    expect(second.delivery.status).toBe('delivered');
    expect(second.contributor.sessionId).toBe(child);
    await service.message('source', contributor.id, { requestId: 'first', text: 'Improve it' });
    expect(port.startChat).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(port.startChat).mock.calls;
    expect(calls[0][2]).toContain(
      `Selected output ${output.outputId}, revision 1, SHA-256 ${output.source.sha256}`,
    );
    expect(calls[0][2]).toContain(JSON.stringify('Selected exact draft'));
    expect(calls[0][3]).toMatchObject({
      accountId: 'api',
      model: input.model,
      reasoningEffort: 'low',
      mode: 'agent',
      initialSessionId: child,
      retainWorkspace: true,
    });
    expect(calls[0][3].resume).toBeUndefined();
    expect(calls[1][3]).toMatchObject({
      accountId: 'api',
      model: input.model,
      reasoningEffort: 'low',
      mode: 'agent',
      resume: child,
      retainWorkspace: true,
    });
    expect(calls[1][3].initialSessionId).toBeUndefined();
    expect(store.getSession('source')).toEqual(parent);
  });

  it.each([
    'api-disabled',
    'runtime-disabled',
    'runtime-incomplete',
    'retained-sandbox',
    'profile-unbound',
    'ask',
  ] as const)('refuses %s before coordinator allocation or provider dispatch', async (kind) => {
    if (kind === 'api-disabled') vi.stubEnv('MITZO_OPENSHELL_OPENAI_API_ENABLED', '0');
    if (kind === 'runtime-disabled') vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
    if (kind === 'runtime-incomplete') vi.stubEnv('MITZO_OPENSHELL_POLICY', undefined);
    if (kind === 'retained-sandbox') vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'offline-retained');
    const { service, store, port, input } = setup(kind === 'profile-unbound' ? '' : undefined);
    if (kind !== 'ask')
      expect((await service.list('source')).eligibility.accountIds).not.toContain('api');
    await expect(
      service.add('source', { ...input, mode: kind === 'ask' ? 'ask' : input.mode }),
    ).rejects.toThrow();
    expect(store.getOutputContributorBindings('source')).toEqual([]);
    expect(port.startChat).not.toHaveBeenCalled();
  });

  it.each(['api-disabled', 'runtime-incomplete', 'retained-sandbox', 'account-changed'] as const)(
    'rejects %s before a retained contributor can dispatch another message',
    async (kind) => {
      const { service, store, port, input, changeAccount } = setup();
      const contributor = await service.add('source', input);
      await service.message('source', contributor.id, { requestId: 'first', text: 'Improve it' });
      if (kind === 'api-disabled') vi.stubEnv('MITZO_OPENSHELL_OPENAI_API_ENABLED', '0');
      if (kind === 'runtime-incomplete') vi.stubEnv('MITZO_OPENSHELL_POLICY', undefined);
      if (kind === 'retained-sandbox')
        vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'offline-retained');
      if (kind === 'account-changed') changeAccount();
      expect((await service.list('source')).contributors[0].status).toBe('unavailable');
      await expect(
        service.message('source', contributor.id, { requestId: 'second', text: 'Continue' }),
      ).rejects.toThrow();
      expect(port.startChat).toHaveBeenCalledOnce();
      expect(store.getSymposiumDeliveries(contributor.id)).toHaveLength(1);
    },
  );

  it('fences an uncertain Stop to its contributor while another same-account contributor continues', async () => {
    const { service, store, port, input } = setup();
    const normalStart = vi.mocked(port.startChat).getMockImplementation()!;
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    vi.mocked(port.startChat).mockImplementationOnce(async (...args) => {
      const options = args[3];
      // Record ordinary child ownership without supplying the terminal receipt.
      const lifecycle = options.ordinaryTurnLifecycle!;
      options.ordinaryTurnLifecycle = { ...lifecycle, terminal: () => {} };
      await normalStart(...args);
      options.onQueryReady?.({ interrupt: vi.fn(async () => {}) });
      await closed;
    });
    const contributor = await service.add('source', input);
    const running = service.message('source', contributor.id, {
      requestId: 'uncertain',
      text: 'Continue',
    });
    await vi.waitFor(() =>
      expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() =>
      expect(
        store.getSymposiumRecipientAttempts(
          store.getSymposiumDeliveries(contributor.id)[0].deliveryId,
        )[0].acceptedAt,
      ).not.toBeNull(),
    );
    close();
    await running;
    const independent = await service.add('source', {
      ...input,
      requestId: 'independent',
      label: 'Independent',
    });
    const stopped = await service.stop('source', contributor.id, { requestId: 'stop' });
    expect(stopped.status).toBe('stopping');
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
      1,
    );
    await expect(
      service.message('source', contributor.id, { requestId: 'competing', text: 'Another' }),
    ).rejects.toThrow('active');
    expect(port.startChat).toHaveBeenCalledOnce();
    const continued = await service.message('source', independent.id, {
      requestId: 'independent-turn',
      text: 'Continue independently',
    });
    expect(continued.delivery.status).toBe('delivered');
    expect(continued.contributor.sessionId).not.toBe(stopped.sessionId);
    expect(store.getUnsettledSymposiumSeatExecutions(independent.id, 'contributor')).toHaveLength(
      0,
    );
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
      1,
    );
    expect(port.startChat).toHaveBeenCalledTimes(2);
  });
});
