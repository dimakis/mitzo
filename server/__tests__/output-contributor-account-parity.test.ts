import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import { createOutputContributors } from '../output-contributors.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import { createOrdinarySymposiumTurn, type OrdinaryChatPort } from '../symposium-ordinary-turn.js';
import { resolveOrdinarySessionRuntime } from '../ordinary-session-runtime.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.restoreAllMocks();
});

/** All accounts and provider acknowledgements are offline fixtures. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'output-account-parity-'));
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
    delta: 'Selected draft',
  });
  store.append('source', 'block_end', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'message_end', { messageId: 'draft' });
  const output = store.registerSessionOutput('source', {
    requestId: 'register',
    title: 'Draft',
    source: store.listSessionOutputCandidates('source')[0].source,
  });
  const profiles = new AccountProfiles(
    [
      {
        id: 'host-codex',
        label: 'Host Codex',
        provider: 'openai-codex',
        credentialRef: join(root, 'unused-codex'),
        email: 'offline@example.invalid',
        planType: 'plus',
        models: [{ id: 'offline-model', label: 'Offline', reasoningEfforts: ['low'] }],
      },
      {
        id: 'api',
        label: 'OpenAI API',
        provider: 'openai',
        credentialRef: { provider: 'offline', service: 'unused', account: 'api' },
        sandboxProvider: 'offline-api',
        sandboxProviderId: 'offline-api-id',
        models: [{ id: 'offline-model', label: 'Offline' }],
      },
      {
        id: 'brokered-codex',
        label: 'Brokered Codex',
        provider: 'openai-codex',
        email: 'brokered@example.invalid',
        planType: 'plus',
        sandboxProvider: 'offline-brokered',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'offline-brokered-id',
        sandboxGrantId: 'offline-grant',
        models: [{ id: 'offline-model', label: 'Offline', reasoningEfforts: ['low'] }],
      },
      {
        id: 'native',
        label: 'Native Codex',
        provider: 'openai-codex',
        nativeAuth: 'sandbox-chatgpt',
        email: 'native@example.invalid',
        planType: 'plus',
        sandboxProvider: 'offline-native',
        sandboxProviderType: 'codex',
        sandboxProviderId: 'offline-native-id',
        models: [{ id: 'offline-model', label: 'Offline' }],
      },
      ...(['google-vertex', 'anthropic-vertex'] as const).map((provider) => ({
        id: provider,
        label: provider,
        provider,
        projectId: 'offline-project',
        region: 'offline-region',
        credentialRef: join(root, 'unused-adc'),
        models: [{ id: 'offline-model', label: 'Offline' }],
      })),
    ],
    { codexEnabled: true },
  );
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
        delta: 'Offline reply',
      });
      options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, rawTurn, 'completed');
      options.onTurnResult?.({});
    }),
  };
  const deps = {
    store,
    databasePath,
    currentAccounts: () => profiles,
    port,
    workspaceForSession: (id: string) => (id === 'source' ? { cwd: root } : null),
    resolveProfile: async () => null,
  };
  const service = createOutputContributors(deps);
  cleanup.push(() => service.close());
  const input = {
    requestId: 'add',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: outputContextPackageDigest('source', output),
    accountId: 'host-codex',
    model: 'offline-model',
    label: 'Contributor',
    instructions: 'Improve the selected source.',
    mode: 'ask' as const,
  };
  return { service, store, profiles, port, deps, input };
}

describe('ordinary output contributor account and harness parity', () => {
  it.each([
    ['host-codex', 'codex', 'local', true],
    ['brokered-codex', 'codex', 'openshell', true],
    ['api', 'codex', 'openshell', false],
    ['api', 'responses', 'local', false],
    ['anthropic-vertex', 'claude-sdk', 'local', false],
    ['google-vertex', 'gemini', 'local', false],
  ] as const)(
    'records ordinary compatibility and bounded contributor eligibility for %s / %s / %s',
    async (accountId, harness, targetId, eligible) => {
      const { service, profiles, port } = setup();
      const binding = profiles.resolve(accountId, 'offline-model');
      const account = {
        accountId: binding.accountId,
        provider: binding.provider,
        profileRevision: binding.profileRevision,
      };
      const configuredAccount =
        binding.provider === 'openai-codex'
          ? {
              ...account,
              planType: 'plus',
              auth:
                accountId === 'host-codex'
                  ? { kind: 'host-login' }
                  : { kind: 'brokered-oauth', targetIds: ['openshell'] },
            }
          : binding.provider === 'openai'
            ? { ...account, auth: { kind: 'api-credential', openshellTargetIds: ['openshell'] } }
            : { ...account, auth: { kind: 'vertex-adc' } };
      const resolution = resolveOrdinarySessionRuntime(
        { account, harness, targetId, mode: 'agent' },
        {
          deployment: 'ordinary',
          enabledHarnesses: ['codex', 'responses', 'claude-sdk', 'gemini'],
          accounts: [configuredAccount],
          targets: [
            { targetId: 'local', targetRevision: 'offline-local-v1', location: 'local' },
            {
              targetId: 'openshell',
              targetRevision: 'offline-shell-v1',
              location: 'openshell',
              ownership: 'dedicated-ordinary',
              openaiApi: 'enabled',
            },
          ],
        },
      );
      expect(resolution).toMatchObject({
        status: 'compatible',
        binding: {
          account,
          harness: { implementation: harness },
          execution: { location: targetId, targetId },
        },
      });
      expect((await service.list('source')).eligibility.accountIds.includes(accountId)).toBe(
        eligible,
      );
      const createTurn = () =>
        createOrdinarySymposiumTurn({ port, binding, cwd: '/offline', mode: 'agent' });
      if (eligible) expect(createTurn).not.toThrow();
      else expect(createTurn).toThrow('only for Codex accounts');
      expect(port.startChat).not.toHaveBeenCalled();
    },
  );

  it.each(['native', 'api', 'google-vertex', 'anthropic-vertex'])(
    'does not allocate or dispatch excluded %s accounts or substitute an eligible account',
    async (accountId) => {
      const { service, input, store, port } = setup();
      expect((await service.list('source')).eligibility.accountIds).not.toContain(accountId);
      await expect(service.add('source', { ...input, accountId })).rejects.toThrow(
        'ordinary contributor turns',
      );
      expect(store.getOutputContributorBindings('source')).toEqual([]);
      expect(port.startChat).not.toHaveBeenCalled();
    },
  );

  it('rejects native Codex in ordinary runtime selection as well as contributor admission', () => {
    const { profiles } = setup();
    const binding = profiles.resolve('native', 'offline-model');
    const account = {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    };
    expect(
      resolveOrdinarySessionRuntime(
        { account, harness: 'codex', targetId: 'openshell', mode: 'agent' },
        {
          deployment: 'ordinary',
          enabledHarnesses: ['codex'],
          accounts: [{ ...account, planType: 'plus', auth: { kind: 'sandbox-chatgpt' } }],
          targets: [
            {
              targetId: 'openshell',
              targetRevision: 'offline-v1',
              location: 'openshell',
              ownership: 'dedicated-ordinary',
              openaiApi: 'enabled',
            },
          ],
        },
      ),
    ).toEqual({ status: 'rejected', code: 'native_auth_ordinary_unsupported' });
  });

  it.each(['host-codex', 'brokered-codex'])(
    'preserves the selected %s account, model and independent child across initial and resumed turns',
    async (accountId) => {
      const { service, port, input, store } = setup();
      const parent = store.getSession('source');
      const contributor = await service.add('source', {
        ...input,
        accountId,
        reasoningEffort: 'low',
        mode: 'agent',
      });
      expect(port.startChat).not.toHaveBeenCalled();
      const first = await service.message('source', contributor.id, {
        requestId: 'first',
        text: 'Improve it',
      });
      expect(first.delivery.status).toBe('delivered');
      expect(first.contributor.messages[0]).toMatchObject({
        symposiumProvenance: {
          accountBinding: { accountId, model: input.model },
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
      const calls = vi.mocked(port.startChat).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][3]).toMatchObject({
        accountId,
        model: input.model,
        reasoningEffort: 'low',
        mode: 'agent',
        initialSessionId: child,
        retainWorkspace: true,
      });
      expect(calls[0][3].resume).toBeUndefined();
      expect(calls[1][3]).toMatchObject({
        accountId,
        model: input.model,
        reasoningEffort: 'low',
        mode: 'agent',
        resume: child,
        retainWorkspace: true,
      });
      expect(calls[1][3].initialSessionId).toBeUndefined();
      expect(store.getSession('source')).toEqual(parent);
    },
  );
});
