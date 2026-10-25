import Database from 'better-sqlite3';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { agentLibrarySource } from './fixtures/agent-library-source.js';

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

import { revokeAuthSession, login, authenticateToken } from '../auth.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { join } from 'node:path';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { OrdinaryLocalCodexHostRuntime } from '../ordinary-local-codex-host-runtime.js';
import { OrdinaryLocalCodexCapabilityCatalog } from '../ordinary-local-codex-capabilities.js';
vi.mock('../auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
import { buildAgentProfilePrompt } from '../agent-library-prompt.js';
import { contextDigest } from '../agent-context-compiler.js';
import {
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  type AgentToolReference,
} from '@mitzo/protocol';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../ordinary-local-codex-owned-runtime.js';

const deployment = vi.hoisted(() => ({ controller: false, owner: false }));
vi.mock('../symposium-custodian-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../symposium-custodian-mode.js')>()),
  get custodianControllerMode() {
    return deployment.controller;
  },
  get custodianOwnerMode() {
    return deployment.owner;
  },
}));
const manifest = vi.hoisted(() => ({ artifacts: undefined as Record<string, string> | undefined }));
vi.mock('../connections/reviewed-handler-artifacts.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../connections/reviewed-handler-artifacts.js')>();
  return {
    ...actual,
    get reviewedHandlerSourceArtifacts() {
      return manifest.artifacts ?? actual.reviewedHandlerSourceArtifacts;
    },
  };
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  manifest.artifacts = undefined;
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  deployment.controller = deployment.owner = false;
});

const fixture = (options?: {
  tools?: AgentToolReference[];
  workspaceId?: string;
  contextRecipe?: boolean | 'workspace';
  silentPreparation?: boolean;
  builtinPreparation?: boolean;
  continuityV2?: boolean;
  chatRoute?: boolean;
  localRepository?: boolean;
  realPreparationAuthority?: boolean;
}) => ownedRuntimeFixture(cleanups, options);

it('binds a fresh prepared barrier to the actual retained operator, lease and physical old workspace', async () => {
  const f = await fixture();
  const runtime = f.create();
  await runtime.admit(f.request);
  const admission = f.dispatch.mock.calls[0][0].admission;
  expect(() => admission.assertPreparedRepositoryBoundaryCurrentSync()).not.toThrow();
  revokeAuthSession(f.auth);
  expect(() => admission.assertPreparedRepositoryBoundaryCurrentSync()).toThrow();
});

it('renews run authority only on an explicit send from another verified operator login', async () => {
  const f = await fixture();
  const runtime = f.create();
  await runtime.admit(f.request);
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const web = await authenticateToken(token!);
  if (!web) throw Error('Fixture login failed');
  const connectionId = randomUUID();
  const release = bindAgentLibraryTransport(connectionId, web);
  cleanups.push(release, () => revokeAuthSession(web));
  const launches = f.launch.mock.calls.length;
  const dispatches = f.dispatch.mock.calls.length;
  runtime.reauthorize(connectionId);
  revokeAuthSession(f.auth);
  await expect(runtime.admit(f.request)).resolves.toEqual({ dispatched: false });
  expect(f.launch).toHaveBeenCalledTimes(launches);
  expect(f.dispatch).toHaveBeenCalledTimes(dispatches);
  revokeAuthSession(web);
  await expect(runtime.admit(f.request)).rejects.toThrow();
});

it('rejects altered reviewed Library source bytes before native startup effects', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    payload: {
      ...f.request.payload,
      sourceSnapshots: [{ ...agentLibrarySource, content: agentLibrarySource.content + ' ' }],
    },
  };
  await expect(f.create().admit(request)).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it('adopts the exact builtin namespace through the ordinary Local owner', async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    selection: {
      ...f.request.selection,
      agent: {
        kind: 'builtin' as const,
        profileId: PROFILE_BUILDER_ID,
        revision: PROFILE_BUILDER_REVISION,
      },
    },
  };
  await expect(f.create().admit(request)).resolves.toEqual({ dispatched: true });
  expect(f.events.getSession(f.reservation.conversationId)?.agentProfile?.kind).toBe('builtin');
});

it('prepares ContexGin context once before native thread effects and retains the exact payload', async () => {
  const f = await fixture({ contextRecipe: true });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          agent: 'fixture-agent',
          boot: {
            content: '# Pinned context\nOffline source',
            tokens: 10,
            tokenBudget: 1000,
            sources: ['source.md'],
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const request = {
    ...f.request,
    selection: {
      ...f.request.selection,
      context: {
        source: 'contexgin' as const,
        revision: contextDigest(f.agentProfile.definition.contextRecipe),
      },
    },
  };
  await expect(f.create().admit(request)).resolves.toEqual({ dispatched: true });
  const snapshot = f.events.getSession(f.reservation.conversationId)?.agentContext;
  expect(snapshot?.context.fullMarkdown).toContain('Offline source');
  expect(f.dispatch.mock.calls[0][0].expected.agentContext).toEqual(snapshot);
  await f.dispatch.mock.calls[0][0].lease.assertCurrent();
  expect(fetch).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it('revocation during compilation retains the uncertain command and never delivers context to a native thread', async () => {
  const f = await fixture({ contextRecipe: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      revokeAuthSession(f.auth);
      return new Response(
        JSON.stringify({
          agent: 'fixture-agent',
          boot: {
            content: '# Context\nMust not deliver',
            tokens: 10,
            tokenBudget: 1000,
            sources: ['source.md'],
          },
        }),
      );
    }),
  );
  const request = {
    ...f.request,
    selection: {
      ...f.request.selection,
      context: {
        source: 'contexgin' as const,
        revision: contextDigest(f.agentProfile.definition.contextRecipe),
      },
    },
  };
  await expect(f.create().admit(request)).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)?.agentContext).toBeUndefined();
  expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)?.state).toBe('uncertain');
  expect(existsSync(f.reserved.directory)).toBe(true);
  vi.unstubAllGlobals();
});

it.each(['consumed', 'uncertain'] as const)(
  'reconciles the original compiled recipe snapshot for an exact %s first-command retry',
  async (state) => {
    const f = await fixture({ contextRecipe: 'workspace' });
    const request = {
      ...f.request,
      selection: {
        ...f.request.selection,
        context: {
          source: 'workspace' as const,
          revision: contextDigest(f.agentProfile.definition.contextRecipe),
        },
      },
    };
    if (state === 'uncertain') f.dispatch.mockRejectedValueOnce(Error('Lost native outcome'));
    if (state === 'consumed') await f.create().admit(request);
    else await expect(f.create().admit(request)).rejects.toThrow();
    const saved = f.events.getSession(f.reservation.conversationId)?.agentContext;
    const receipt = f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId);
    expect(saved?.source).toBe('workspace');
    expect(receipt?.state).toBe(state);
    if (state === 'consumed') {
      const original = f.dispatch.mock.calls[0][0];
      const native = new CodexConversationStore(join(f.root, 'historical-native.db'));
      cleanups.push(() => native.close());
      native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
      original.admission.persistCustody(native);
      native.bindThread(original.sessionId, original.lease.binding, 'retained-thread');
      vi.spyOn(
        await import('../codex-chat-session.js'),
        'getCodexConversationStore',
      ).mockReturnValue(native);
      vi.spyOn(
        await import('../repository-workspace-runtime.js'),
        'getRepositoryWorkspaces',
      ).mockReturnValue(f.workspace);
      const { assertOrdinaryHistoricalAcknowledgement } =
        await import('../ordinary-command-historical-ack.js');
      const { LocalCodexFirstCommandSchema } = await import('@mitzo/protocol');
      const wire = LocalCodexFirstCommandSchema.parse({
        ...request,
        runOn: 'local',
        repositoryWorkspaceId: f.reservation.id,
      });
      const originalConfiguration = structuredClone(f.configuration);
      f.configuration[0].models = [
        { id: 'future-C', label: 'Current supported C', reasoningEfforts: ['low'] },
      ];
      f.configuration[0].label = 'Updated display label';
      f.writeProfiles();
      const commandCount = native.commands(original.sessionId, original.lease.binding).length;
      const launchCount = f.launch.mock.calls.length;
      const dispatchCount = f.dispatch.mock.calls.length;
      expect(
        assertOrdinaryHistoricalAcknowledgement(
          f.events,
          original.sessionId,
          f.auth.id,
          wire,
          true,
        ),
      ).toBe(true);
      const custody = native.readHostCustody(original.sessionId, original.lease.binding)!;
      const corrupt = new Database(join(f.root, 'historical-native.db'));
      try {
        corrupt
          .prepare('UPDATE codex_conversations SET host_custody=? WHERE id=?')
          .run(JSON.stringify({ ...custody, bootstrapId: 'f'.repeat(64) }), original.sessionId);
        expect(() =>
          assertOrdinaryHistoricalAcknowledgement(
            f.events,
            original.sessionId,
            f.auth.id,
            wire,
            true,
          ),
        ).toThrow();
      } finally {
        corrupt
          .prepare('UPDATE codex_conversations SET host_custody=? WHERE id=?')
          .run(JSON.stringify(custody), original.sessionId);
        corrupt.close();
      }

      expect(() =>
        assertOrdinaryHistoricalAcknowledgement(
          f.events,
          original.sessionId,
          f.auth.id,
          { ...wire, payload: { text: 'Changed historical input' } },
          true,
        ),
      ).toThrow();
      expect(() =>
        assertOrdinaryHistoricalAcknowledgement(
          f.events,
          original.sessionId,
          'foreign-operator',
          wire,
          true,
        ),
      ).toThrow();
      expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)).toEqual(receipt);
      expect(f.events.getSession(original.sessionId)?.agentContext).toEqual(saved);
      expect(native.commands(original.sessionId, original.lease.binding)).toHaveLength(
        commandCount,
      );
      expect(f.launch).toHaveBeenCalledTimes(launchCount);
      expect(f.dispatch).toHaveBeenCalledTimes(dispatchCount);
      // Fresh owner retry below still exercises its existing current-catalog authority.
      f.configuration.splice(0, f.configuration.length, ...originalConfiguration);
      f.writeProfiles();
    }
    f.launch.mockClear();
    f.dispatch.mockClear();
    await expect(f.create().admit(request)).resolves.toEqual({ dispatched: false });
    expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)).toEqual(receipt);
    expect(f.events.getSession(f.reservation.conversationId)?.agentContext).toEqual(saved);
    await expect(
      f.create().admit({ ...request, payload: { text: 'Changed original input' } }),
    ).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);

it.each(['workspace', 'contexgin'] as const)(
  'cold %s continuation keeps the original compiled snapshot without reading fresh source',
  async (source) => {
    const f = await fixture({ contextRecipe: source === 'workspace' ? 'workspace' : true });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            agent: 'fixture-agent',
            boot: {
              content: '# Pinned context\nOriginal source',
              tokens: 10,
              tokenBudget: 1000,
              sources: ['source.md'],
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const request = {
      ...f.request,
      selection: {
        ...f.request.selection,
        context: { source, revision: contextDigest(f.agentProfile.definition.contextRecipe) },
      },
    };
    const first = f.create();
    await first.admit(request);
    const original = f.dispatch.mock.calls[0][0];
    const snapshot = f.events.getSession(original.sessionId)?.agentContext;
    expect(snapshot?.context.fullMarkdown).toContain(
      source === 'workspace' ? 'Pinned original checkout' : 'Original source',
    );
    const native = new CodexConversationStore(join(f.root, 'native.db'));
    cleanups.push(() => native.close());
    native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
    original.admission.persistCustody(native);
    native.bindThread(original.sessionId, original.lease.binding, 'retained-thread');
    first.close();
    writeFileSync(join(original.workspace.directory!, 'context.md'), '# Changed source');
    fetch.mockImplementation(async () => {
      throw Error('Cold resume must not refetch');
    });
    const next = {
      ...request,
      clientMsgId: randomUUID(),
      payload: { text: 'Continue original context' },
    };
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      expect(value.expected.agentContext).toEqual(snapshot);
      value.admission.assertOptions({
        conversationId: value.sessionId,
        messageId: value.commandId,
        binding: value.lease.binding,
        profile: value.profile,
        session: { cwd: value.expected.workspace.cwd, mode: 'agent' },
        prompt: value.payload.text,
        systemPrompt: value.payload.systemPrompt,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        repositoryWorkspace: value.workspace,
        resume: true,
      });
    });
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      commandId: next.clientMsgId,
      launch: () => f.rpc,
      dispatch,
    });
    cleanups.push(() => cold.close());
    await expect(cold.admitResume(next)).resolves.toEqual({ dispatched: true });
    expect(f.events.getSession(original.sessionId)?.agentContext).toEqual(snapshot);
    expect(native.read(original.sessionId, original.lease.binding).threadId).toBe(
      'retained-thread',
    );
    expect(fetch).toHaveBeenCalledTimes(source === 'workspace' ? 0 : 1);
    vi.spyOn(await import('../codex-chat-session.js'), 'getCodexConversationStore').mockReturnValue(
      native,
    );
    vi.spyOn(
      await import('../repository-workspace-runtime.js'),
      'getRepositoryWorkspaces',
    ).mockReturnValue(f.workspace);
    const { LocalCodexContinuationCommandSchema } = await import('@mitzo/protocol');
    const wire = LocalCodexContinuationCommandSchema.parse({
      ...next,
      runOn: 'local',
      repositoryWorkspaceId: f.reservation.id,
      sessionId: original.sessionId,
    });
    const retainedReceipt = f.events.getOrdinaryLocalCommandAdmission(next.clientMsgId);
    f.configuration[0].models = [
      { id: 'future-C', label: 'Current supported C', reasoningEfforts: ['low'] },
    ];
    f.writeProfiles();
    const { assertOrdinaryHistoricalAcknowledgement } =
      await import('../ordinary-command-historical-ack.js');
    expect(
      assertOrdinaryHistoricalAcknowledgement(f.events, original.sessionId, f.auth.id, wire, false),
    ).toBe(true);
    expect(() =>
      assertOrdinaryHistoricalAcknowledgement(
        f.events,
        original.sessionId,
        f.auth.id,
        { ...wire, payload: { text: 'Changed' } },
        false,
      ),
    ).toThrow();
    expect(f.events.getOrdinaryLocalCommandAdmission(next.clientMsgId)).toEqual(retainedReceipt);
    expect(f.events.getSession(original.sessionId)?.agentContext).toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(source === 'workspace' ? 0 : 1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  },
);

it('refuses cold context metadata that no longer matches the original native custody', async () => {
  const f = await fixture({ contextRecipe: true });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            agent: 'fixture-agent',
            boot: { content: 'Original context', tokens: 5, tokenBudget: 1000, sources: [] },
          }),
        ),
    ),
  );
  const request = {
    ...f.request,
    selection: {
      ...f.request.selection,
      context: {
        source: 'contexgin' as const,
        revision: contextDigest(f.agentProfile.definition.contextRecipe),
      },
    },
  };
  const first = f.create();
  await first.admit(request);
  const original = f.dispatch.mock.calls[0][0];
  const native = new CodexConversationStore(join(f.root, 'native.db'));
  cleanups.push(() => native.close());
  native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
  original.admission.persistCustody(native);
  native.bindThread(original.sessionId, original.lease.binding, 'original-thread');
  first.close();
  const snapshot = f.events.getSession(original.sessionId)!.agentContext!;
  const context = { ...snapshot.context, fullMarkdown: 'Replaced context' };
  // A corrupted snapshot reader still cannot replace the independently retained native owner.
  const retainedMeta = f.events.getSession(original.sessionId)!;
  const readSession = f.events.getSession.bind(f.events);
  vi.spyOn(f.events, 'getSession').mockImplementation((id) =>
    id === original.sessionId
      ? {
          ...retainedMeta,
          agentContext: { ...snapshot, context, payloadHash: contextDigest(context) },
        }
      : readSession(id),
  );
  const next = { ...request, clientMsgId: randomUUID(), payload: { text: 'Continue' } };
  const launch = vi.fn(() => f.rpc),
    dispatch = vi.fn();
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: native,
    commandId: next.clientMsgId,
    launch,
    dispatch,
  });
  cleanups.push(() => cold.close());
  await expect(cold.admitResume(next)).rejects.toThrow();
  expect(launch).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(f.events.getSendCommand(next.clientMsgId)).toBeUndefined();
  vi.unstubAllGlobals();
});

it('composes real owners, freezes the published prompt before launch and materializes only the admitted reservation', async () => {
  const f = await fixture(),
    driver = f.create();
  expect(existsSync(f.reserved.directory)).toBe(false);
  await expect(driver.admit(f.request)).resolves.toEqual({ dispatched: true });
  expect(f.events.getSendCommand(f.request.clientMsgId)?.payload).toEqual({
    ...f.request.payload,
    systemPrompt: buildAgentProfilePrompt(f.agentProfile.definition),
  });
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe('consumed');
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
  f.detach();
  await expect(f.dispatch.mock.calls[0][0].lease.assertCurrent()).resolves.toBeUndefined();
  expect(f.rpc.close).not.toHaveBeenCalled();
  revokeAuthSession(f.auth);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
  await expect(f.dispatch.mock.calls[0][0].lease.assertCurrent()).rejects.toThrow();
});

it('refuses a builtin namespace collision before looking up its matching published user profile', async () => {
  const f = await fixture(),
    driver = f.create();
  expect(
    f.library.version(
      'user',
      f.request.selection.agent.profileId,
      f.request.selection.agent.revision,
    ),
  ).toEqual(f.agentProfile);
  const version = vi.spyOn(f.library, 'version');
  const request = structuredClone(f.request);
  const input = {
    ...request,
    selection: {
      ...request.selection,
      agent: { ...request.selection.agent, kind: 'builtin' as const },
    },
  };
  await expect(driver.admit(input)).rejects.toThrow('Owned local Codex runtime unavailable');
  expect(version).not.toHaveBeenCalled();
  expect(f.events.getSendCommand(f.request.clientMsgId)).toBeUndefined();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(existsSync(f.reserved.directory)).toBe(false);
});

it.each(['systemPrompt', 'metadata', 'command', 'profile', 'permission', 'context'] as const)(
  'refuses caller %s forgery before a ledger or native effect',
  async (kind) => {
    const f = await fixture(),
      driver = f.create();
    const input = structuredClone(f.request) as unknown as Record<string, unknown>;
    if (kind === 'systemPrompt')
      input.payload = { ...f.request.payload, systemPrompt: 'Caller instructions' };
    if (kind === 'metadata') input.meta = { cwd: '/forged', accountBinding: 'forged' };
    if (kind === 'command') input.clientMsgId = randomUUID();
    if (kind === 'profile')
      input.selection = { ...f.request.selection, agent: { profileId: 'missing', revision: 1 } };
    if (kind === 'permission')
      input.selection = { ...f.request.selection, permission: { mode: 'agent', revision: 1 } };
    if (kind === 'context')
      input.selection = {
        ...f.request.selection,
        context: { source: 'packs', revision: 'forged' },
      };
    await expect(driver.admit(input)).rejects.toThrow('Owned local Codex runtime unavailable');
    expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(existsSync(f.reserved.directory)).toBe(false);
  },
);

it.each(['consumed', 'uncertain'] as const)(
  'keeps %s retries free of native bootstrap and dispatch',
  async (state) => {
    const f = await fixture(),
      driver = f.create();
    if (state === 'uncertain')
      f.dispatch.mockRejectedValueOnce(Error('Provider outcome uncertain'));
    if (state === 'consumed') await driver.admit(f.request);
    else await expect(driver.admit(f.request)).rejects.toThrow();
    f.launch.mockClear();
    f.dispatch.mockClear();
    const retry = f.create();
    await expect(retry.admit(f.request)).resolves.toEqual({ dispatched: false });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(state);
  },
);

it.each(['account', 'target', 'native', 'auth'] as const)(
  'refuses %s drift before bootstrap',
  async (kind) => {
    const f = await fixture(),
      driver = f.create();
    if (kind === 'account') {
      f.configuration[0].email = 'replacement@example.test';
      f.writeProfiles();
    }
    if (kind === 'target')
      writeFileSync(f.targetPath, JSON.stringify({ ...f.target, targetId: 'replacement' }));
    if (kind === 'native')
      writeFileSync(f.executablePath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9]));
    if (kind === 'auth') revokeAuthSession(f.auth);
    await expect(driver.admit(f.request)).rejects.toThrow('Owned local Codex runtime unavailable');
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  },
);

it('rejects an existing conversation without adopting it', async () => {
  const f = await fixture(),
    driver = f.create();
  f.events.upsertSession({ sessionId: f.reservation.conversationId, mode: 'agent' });
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
});

it('refuses event-only orphan history before any native bootstrap', async () => {
  const f = await fixture(),
    driver = f.create();
  f.events.append(f.reservation.conversationId, 'user_message', {
    messageId: 'old',
    content: 'retained history',
  });
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
});

it('refuses a claimed workspace orphan without its original EventStore command receipt', async () => {
  const f = await fixture();
  await f.workspace.claimReservedHostTask({ ...f.reservation, signal: f.signal.signal });
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)).toBeUndefined();
  f.launch.mockImplementation(() => f.rpc);
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  expect(existsSync(f.reserved.directory)).toBe(true);
});

it('releases its auth observer and owned client on explicit close while retaining workspace and private custody', async () => {
  const f = await fixture(),
    driver = f.create();
  await driver.admit(f.request);
  const lease = f.dispatch.mock.calls[0][0].lease;
  driver.close();
  driver.close();
  revokeAuthSession(f.auth);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
  expect(existsSync(lease.privateHome)).toBe(true);
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe('consumed');
});

it('never enables a route without the explicit server gate', async () => {
  const f = await fixture();
  f.dependencies.enabled = false;
  expect(() => f.create()).toThrow();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
});

it('keeps the original lease after same-driver duplicate or conflicting retry', async () => {
  const f = await fixture(),
    driver = f.create();
  await driver.admit(f.request);
  const lease = f.dispatch.mock.calls[0][0].lease;
  await expect(driver.admit(f.request)).resolves.toEqual({ dispatched: false });
  await expect(
    driver.admit({ ...f.request, payload: { text: 'Changed intent' } }),
  ).rejects.toThrow();
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.rpc.close).not.toHaveBeenCalled();
  await expect(lease.assertCurrent()).resolves.toBeUndefined();
});

it('admits only one concurrent first command through the existing uncertainty claim', async () => {
  const f = await fixture(),
    driver = f.create();
  const results = await Promise.all([
    driver.admit(f.request),
    driver.admit(structuredClone(f.request)),
  ]);
  expect(results.map((result) => result.dispatched).sort()).toEqual([false, true]);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('keeps the winning concurrent command alive when another payload conflicts', async () => {
  const f = await fixture(),
    driver = f.create();
  const results = await Promise.allSettled([
    driver.admit(f.request),
    driver.admit({ ...f.request, payload: { text: 'Conflicting command intent' } }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.rpc.close).not.toHaveBeenCalled();
  await expect(f.dispatch.mock.calls[0][0].lease.assertCurrent()).resolves.toBeUndefined();
});

it('returns false on an exact same-driver uncertain retry after closing only its failed native attempt', async () => {
  const f = await fixture(),
    driver = f.create();
  f.dispatch.mockRejectedValueOnce(Error('uncertain callback'));
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.rpc.close).toHaveBeenCalledOnce();
  f.launch.mockClear();
  f.dispatch.mockClear();
  await expect(driver.admit(f.request)).resolves.toEqual({ dispatched: false });
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['config', 'account', 'abort'] as const)(
  'retains durable uncertainty after bootstrap %s refusal',
  async (kind) => {
    const f = await fixture(),
      driver = f.create();
    const ordinaryRequest = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method) => {
      if (kind === 'config' && method === 'config/read')
        return { config: { model_providers: { openai: {} } } };
      if (kind === 'account' && method === 'account/read')
        return { account: { type: 'chatgpt', email: 'wrong@example.test', planType: 'plus' } };
      if (kind === 'abort' && method === 'model/list') f.signal.abort();
      return ordinaryRequest(method);
    });
    await expect(driver.admit(f.request)).rejects.toThrow('Owned local Codex runtime unavailable');
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
      'uncertain',
    );
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(existsSync(f.reserved.directory)).toBe(false);
    expect(f.rpc.close).toHaveBeenCalledOnce();
  },
);

it('checks changed real target configuration synchronously before later native/tool effects', async () => {
  const f = await fixture(),
    driver = f.create();
  await driver.admit(f.request);
  const admitted = f.dispatch.mock.calls[0][0];
  writeFileSync(f.targetPath, JSON.stringify({ ...f.target, targetId: 'replacement' }));
  expect(() => admitted.admission.assertCurrentSync()).toThrow();
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
});

it('retains the admitted operator expiry after detach and closes without deleting task files', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const driver = f.create();
  await driver.admit(f.request);
  f.detach();
  await vi.advanceTimersByTimeAsync(60001);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(existsSync(f.reserved.directory)).toBe(true);
  driver.close();
  expect(f.rpc.close).toHaveBeenCalledOnce();
});

it('rejects reusable profile context until its own runtime delivery is qualified', async () => {
  const f = await fixture({ contextRecipe: true });
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
});

it('rejects workspace-scoped host accounts without native workspace proof', async () => {
  const f = await fixture({ workspaceId: 'unattested-workspace' });
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
});

it.each(['controller', 'owner'] as const)(
  'refuses custodian %s construction before effects',
  async (kind) => {
    const f = await fixture();
    deployment[kind] = true;
    expect(() => f.create()).toThrow('Owned local Codex runtime unavailable');
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  },
);

it.each([
  { tools: undefined },
  { tools: [] },
  { tools: [{ id: 'mitzo:Read', version: 1 }] },
] satisfies { tools?: AgentToolReference[] }[])(
  'retains native custody and selected tools for an admitted later command without replaying consumed retries: %j',
  async ({ tools }) => {
    const f = await fixture({ tools });
    const continuation = vi.fn(async (input: OrdinaryLocalCodexOwnedDispatch) => {
      expect(input.lease).toBe(f.dispatch.mock.calls[0][0].lease);
      expect(input.expected.agentProfile).toEqual(f.agentProfile);
      expect(f.events.getOrdinaryLocalCommandAdmission(input.commandId)?.state).toBe('uncertain');
      input.admission.assertBeforeEnqueue({
        id: input.commandId,
        prompt: input.payload.text,
        intent: input.payload.intent,
        model: input.expected.selection.model,
        reasoningEffort: input.expected.selection.thinking,
      });
    });
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      dispatchContinuation: continuation,
    });
    cleanups.push(() => driver.close());
    await driver.admit(f.request);
    const next = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: { text: 'Second explicit message' },
    };
    const changedProfile = {
      ...structuredClone(next),
      clientMsgId: randomUUID(),
      selection: {
        ...next.selection,
        agent: { ...next.selection.agent, revision: next.selection.agent.revision + 1 },
      },
    };
    await expect(driver.admitContinuation(changedProfile)).rejects.toThrow();
    expect(continuation).not.toHaveBeenCalled();
    expect(f.events.getSendCommand(changedProfile.clientMsgId)).toBeUndefined();
    await expect(driver.admitContinuation(next)).resolves.toEqual({ dispatched: true });
    expect(f.events.getOrdinaryLocalCommandAdmission(next.clientMsgId)?.state).toBe('consumed');
    expect(f.launch).toHaveBeenCalledOnce();
    expect(continuation).toHaveBeenCalledOnce();
    await expect(driver.admitContinuation(next)).resolves.toEqual({ dispatched: false });
    expect(continuation).toHaveBeenCalledOnce();
    const admission = f.dispatch.mock.calls[0][0].admission;
    admission.assertBeforeDispatch(next.clientMsgId);
    expect(() => admission.assertBeforeDispatch(next.clientMsgId)).toThrow();
  },
);

it('rejects missing native model support before saving a later command and retains task files', async () => {
  const f = await fixture();
  const continuation = vi.fn();
  const driver = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    dispatchContinuation: continuation,
  });
  cleanups.push(() => driver.close());
  await driver.admit(f.request);
  const rpc = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method) =>
    method === 'model/list' ? { data: [], nextCursor: null } : rpc(method),
  );
  const next = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Missing native support' },
  };
  await expect(driver.admitContinuation(next)).rejects.toThrow();
  expect(f.events.getSendCommand(next.clientMsgId)).toBeUndefined();
  expect(continuation).not.toHaveBeenCalled();
  // An empty native catalog is a discovery-contract failure, not removal of
  // one historical model while another supported selection remains available.
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
});

it.each([false, true])(
  'reopens exact retained cold custody with changed model %s and frozen queued settings',
  async (changedModel) => {
    const f = await fixture();
    if (changedModel) {
      f.configuration[0].models.push({
        id: 'future-model',
        label: 'Future',
        reasoningEfforts: ['high'],
      });
      f.writeProfiles();
      f.request.capabilityRevision = new OrdinaryLocalCodexCapabilityCatalog(
        loadAccountProfiles(),
        new OrdinaryLocalCodexHostRuntime(f.dependencies.env).target(),
        'ordinary',
      ).inventory().capabilityRevision;
      const rpc = f.rpc.request.getMockImplementation()!;
      f.rpc.request.mockImplementation(async (method) =>
        method === 'model/list'
          ? {
              data: [
                {
                  model: 'fixture-model',
                  displayName: 'Fixture',
                  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                },
                {
                  model: 'future-model',
                  displayName: 'Future',
                  supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                },
              ],
              nextCursor: null,
            }
          : rpc(method),
      );
    }
    const first = f.create();
    await first.admit(f.request);
    const original = f.dispatch.mock.calls[0][0];
    const native = new CodexConversationStore(join(f.root, 'native.db'));
    cleanups.push(() => native.close());
    native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
    original.admission.persistCustody(native);
    native.bindThread(original.sessionId, original.lease.binding, 'retained-thread');
    const custody = native.readHostCustody(original.sessionId, original.lease.binding)!;
    native.enqueue(original.sessionId, original.lease.binding, {
      id: original.commandId,
      prompt: original.payload.text,
      intent: original.payload.intent,
      model: original.expected.selection.model,
      reasoningEffort: original.expected.selection.thinking,
    });
    native.claimNext(original.sessionId, original.lease.binding);
    native.recoverAtStartup('ordinary');
    expect(native.commands(original.sessionId, original.lease.binding)[0].status).toBe(
      'interrupted',
    );
    const queuedId = randomUUID(),
      queuedPayload = { text: 'Saved FIFO message', systemPrompt: original.payload.systemPrompt };
    f.events.admitOrdinaryLocalContinuation(
      {
        sessionId: original.sessionId,
        accountBinding: original.lease.binding,
        cwd: original.workspace.directory,
        repositoryWorkspaceId: original.workspace.id,
        agentProfile: original.expected.agentProfile,
        mode: 'agent',
        selectedModel: original.expected.selection.model,
        reasoningEffort: original.expected.selection.thinking,
      },
      original.expected.binding,
      {
        clientMsgId: queuedId,
        requestFingerprint: 'saved-queue',
        selection: original.expected.selection,
        payload: queuedPayload,
      },
    );
    f.events.claimOrdinaryLocalCommandDispatch(queuedId);
    f.events.completeOrdinaryLocalCommand(queuedId);
    native.enqueue(original.sessionId, original.lease.binding, {
      id: queuedId,
      prompt: queuedPayload.text,
      model: original.expected.selection.model,
      reasoningEffort: original.expected.selection.thinking,
    });
    first.close();
    const next = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: { text: 'Resume original thread' },
    };
    if (changedModel) {
      next.selection.model = 'future-model';
      next.selection.thinking = 'high';
    }
    const resumed = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      expect(value.resume).toBe(true);
      expect(value.lease.binding.model).toBe('fixture-model');
      expect(value.expected.selection.model).toBe(changedModel ? 'future-model' : 'fixture-model');
      expect(value.lease.privateHome).toBe(custody.login.privateHome);
      value.admission.assertOptions({
        conversationId: value.sessionId,
        messageId: value.commandId,
        resume: true,
        binding: value.lease.binding,
        profile: value.profile,
        session: { cwd: value.workspace.directory, mode: 'agent' },
        prompt: value.payload.text,
        systemPrompt: value.payload.systemPrompt,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
        agentProfile: value.expected.agentProfile,
        repositoryWorkspace: value.workspace,
      });
      value.admission.persistCustody(native);
      value.admission.assertBeforeDispatch(queuedId);
      expect(() => value.admission.assertBeforeDispatch(queuedId)).toThrow();
      expect(
        native
          .commands(value.sessionId, value.lease.binding)
          .find((command) => command.status === 'queued')?.id,
      ).toBe(queuedId);
      expect(() => value.admission.assertBeforeDispatch(original.commandId)).toThrow();
      expect(native.commands(value.sessionId, value.lease.binding)[0].status).toBe('interrupted');
      value.admission.assertBeforeEnqueue({
        id: value.commandId,
        prompt: value.payload.text,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      });
    });
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      commandId: next.clientMsgId,
      launch: () => f.rpc,
      dispatch: resumed,
    });
    cleanups.push(() => driver.close());
    await expect(driver.admitResume(next)).resolves.toEqual({ dispatched: true });
    expect(resumed).toHaveBeenCalledOnce();
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
      'consumed',
    );
    expect(native.read(original.sessionId, original.lease.binding).threadId).toBe(
      'retained-thread',
    );
    expect(native.readHostCustody(original.sessionId, original.lease.binding)).toEqual(custody);
  },
);

it.each(['legacy', 'other-operator'] as const)(
  'refuses cold %s adoption before native effects',
  async (reason) => {
    const f = await fixture(),
      first = f.create();
    await first.admit(f.request);
    const original = f.dispatch.mock.calls[0][0];
    const native = new CodexConversationStore(join(f.root, 'native.db'));
    cleanups.push(() => native.close());
    native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
    if (reason !== 'legacy') original.admission.persistCustody(native);
    native.bindThread(original.sessionId, original.lease.binding, 'retained-thread');
    first.close();
    const next = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: { text: 'Cold command' },
    };
    const otherId = randomUUID();
    cleanups.push(
      bindAgentLibraryTransport(otherId, { id: 'another-operator', expiresAt: Date.now() + 60000 }),
    );
    const launch = vi.fn(() => f.rpc),
      dispatch = vi.fn();
    const driver = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      operatorConnectionId:
        reason === 'other-operator' ? otherId : f.dependencies.operatorConnectionId,
      commandId: next.clientMsgId,
      launch,
      dispatch,
    });
    cleanups.push(() => driver.close());
    await expect(driver.admitResume(next)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.events.getSendCommand(next.clientMsgId)).toBeUndefined();
    expect(native.read(original.sessionId, original.lease.binding).threadId).toBe(
      'retained-thread',
    );
  },
);

it.each(['completed', 'queued', 'running'] as const)(
  'checks removed original model against %s native work rather than completed history',
  async (status) => {
    const f = await fixture();
    f.configuration[0].models.push({
      id: 'future-model',
      label: 'Future',
      reasoningEfforts: ['low'],
    });
    f.writeProfiles();
    const revision = () =>
      new OrdinaryLocalCodexCapabilityCatalog(
        loadAccountProfiles(),
        new OrdinaryLocalCodexHostRuntime(f.dependencies.env).target(),
        'ordinary',
      ).inventory().capabilityRevision;
    f.request.capabilityRevision = revision();
    const rpc = f.rpc.request.getMockImplementation()!;
    let originalAvailable = true;
    f.rpc.request.mockImplementation(async (method) =>
      method === 'model/list'
        ? {
            data: [
              ...(originalAvailable
                ? [
                    {
                      model: 'fixture-model',
                      displayName: 'Fixture',
                      supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
                    },
                  ]
                : []),
              {
                model: 'future-model',
                displayName: 'Future',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
              },
            ],
            nextCursor: null,
          }
        : rpc(method),
    );
    const native = new CodexConversationStore(join(f.root, 'native.db'));
    cleanups.push(() => native.close());
    const continuation = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) =>
      value.admission.assertBeforeEnqueue({
        id: value.commandId,
        prompt: value.payload.text,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      }),
    );
    const first = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      dispatchContinuation: continuation,
      dispatch: async (value) => {
        await f.dispatch(value);
        native.create(value.sessionId, value.lease.binding, value.workspace.directory!);
        value.admission.persistCustody(native);
        native.enqueue(value.sessionId, value.lease.binding, {
          id: value.commandId,
          prompt: value.payload.text,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        });
        if (status !== 'queued') native.claimNext(value.sessionId, value.lease.binding);
        if (status === 'completed')
          native.finish(value.sessionId, value.lease.binding, value.commandId, 'completed');
      },
    });
    cleanups.push(() => first.close());
    await first.admit(f.request);
    f.configuration[0].models.splice(0, 1);
    f.writeProfiles();
    originalAvailable = false;
    const next = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      capabilityRevision: revision(),
      selection: { ...f.request.selection, model: 'future-model' },
      payload: { text: 'Valid future model' },
    };
    if (status === 'completed') {
      await expect(first.admitContinuation(next)).resolves.toEqual({ dispatched: true });
      expect(continuation).toHaveBeenCalledOnce();
      expect(f.rpc.close).not.toHaveBeenCalled();
    } else {
      await expect(first.admitContinuation(next)).rejects.toThrow();
      expect(continuation).not.toHaveBeenCalled();
      expect(f.events.getSendCommand(next.clientMsgId)).toBeUndefined();
      expect(native.commands(f.reservation.conversationId, f.reservation.binding)[0].status).toBe(
        status,
      );
    }
  },
);

it('refuses a timed-out warm model admission while preserving the original retained native owner', async () => {
  const f = await fixture();
  const dispatch = vi.fn(async () => {});
  const driver = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    dispatchContinuation: dispatch,
  });
  cleanups.push(() => driver.close());
  await driver.admit(f.request);
  const originalRequest = f.rpc.request.getMockImplementation()!;
  let release!: () => void;
  let waiting = false;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.rpc.request.mockImplementation(async (method) => {
    if (method === 'model/list') {
      waiting = true;
      await deferred;
    }
    return originalRequest(method);
  });
  const controller = new AbortController();
  const next = {
    ...f.request,
    clientMsgId: randomUUID(),
    payload: { text: 'Expired future command' },
  };
  const pending = driver.admitContinuation(next, controller.signal).then(
    () => 'accepted',
    () => 'refused',
  );
  await vi.waitFor(() => expect(waiting).toBe(true));
  controller.abort(new Error('Incoming preparation deadline'));
  release();
  expect(await pending).toBe('refused');
  expect(f.events.getSendCommand(next.clientMsgId)).toBeUndefined();
  expect(dispatch).not.toHaveBeenCalled();
  f.dispatch.mock.calls[0][0].admission.assertCurrentSync();
  f.rpc.request.mockImplementation(originalRequest);
  await expect(driver.admitContinuation({ ...next, clientMsgId: randomUUID() })).resolves.toEqual({
    dispatched: true,
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledOnce();
});

it('uses the silently prepared ordinary session for its first explicit command without continuation', async () => {
  const f = await fixture({ silentPreparation: true });
  expect(f.preparation?.reservation).toEqual(f.reservation);
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getOrdinaryInitialCommandId(f.reservation.conversationId)).toBeUndefined();
  await expect(f.create().admitPreparedFirst('allocation', f.request)).resolves.toEqual({
    dispatched: true,
  });
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.events.getSendCommand(f.request.clientMsgId)?.sessionId).toBe(
    f.preparation?.receipt.sessionId,
  );
  expect(f.events.getOrdinarySessionPreparation('allocation')?.firstCommandId).toBe(
    f.request.clientMsgId,
  );
  await expect(f.create().admitPreparedFirst('allocation', f.request)).resolves.toEqual({
    dispatched: false,
  });
  await expect(f.create().admitPreparedFirst('other-operation', f.request)).rejects.toThrow();
  await expect(
    f.create().admitPreparedFirst('allocation', { ...f.request, clientMsgId: 'other-command' }),
  ).rejects.toThrow();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('preserves the actual builtin profile namespace through silent workspace preparation and first command', async () => {
  const f = await fixture({ silentPreparation: true, builtinPreparation: true });
  expect(f.preparation?.receipt.settings.selection.agent.kind).toBe('builtin');
  expect(f.events.getSession(f.reservation.conversationId)?.agentProfile).toEqual(f.agentProfile);
  expect(f.launch).not.toHaveBeenCalled();
  await expect(f.create().admitPreparedFirst('allocation', f.request)).resolves.toEqual({
    dispatched: true,
  });
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('prepares and starts two independent ordinary sessions sharing one account and profile', async () => {
  const first = await fixture({ silentPreparation: true });
  const second = await first.prepareSibling();
  const prepared = [first.preparation!, second.preparation];
  expect(new Set(prepared.map((item) => item.receipt.workspaceId)).size).toBe(2);
  expect(new Set(prepared.map((item) => item.receipt.sessionId)).size).toBe(2);
  expect(new Set(prepared.map((item) => item.receipt.allocationOperationId)).size).toBe(2);
  expect(first.reservation.binding).toEqual(second.reservation.binding);
  expect(first.request.selection.agent).toEqual(second.request.selection.agent);
  for (const item of prepared) {
    expect(item.receipt.sessionId).not.toBe(item.receipt.workspaceId);
    expect(first.events.getOrdinaryInitialCommandId(item.receipt.sessionId)).toBeUndefined();
    expect(first.events.getSendCommand(item.receipt.allocationOperationId)).toBeUndefined();
    expect(first.events.getEventsAfter(item.receipt.sessionId, 0)).toEqual([]);
  }
  expect(first.launch).not.toHaveBeenCalled();
  expect(second.launch).not.toHaveBeenCalled();
  expect(first.dispatch).not.toHaveBeenCalled();
  expect(second.dispatch).not.toHaveBeenCalled();
  const firstOwner = first.create(),
    secondOwner = second.create();
  await expect(
    Promise.all([
      firstOwner.admitPreparedFirst(
        first.preparation!.receipt.allocationOperationId,
        first.request,
      ),
      secondOwner.admitPreparedFirst(
        second.preparation.receipt.allocationOperationId,
        second.request,
      ),
    ]),
  ).resolves.toEqual([{ dispatched: true }, { dispatched: true }]);
  expect(first.dispatch).toHaveBeenCalledOnce();
  expect(second.dispatch).toHaveBeenCalledOnce();
  expect(first.launch).toHaveBeenCalledOnce();
  expect(second.launch).toHaveBeenCalledOnce();
  expect(first.rpc).not.toBe(second.rpc);
  const firstTurn = first.dispatch.mock.calls[0][0],
    secondTurn = second.dispatch.mock.calls[0][0];
  expect(firstTurn.lease.privateHome).not.toBe(secondTurn.lease.privateHome);
  expect(firstTurn.workspace.directory).not.toBe(secondTurn.workspace.directory);
  expect(first.events.getSendCommand(first.request.clientMsgId)?.sessionId).toBe(
    first.preparation!.receipt.sessionId,
  );
  expect(first.events.getSendCommand(second.request.clientMsgId)?.sessionId).toBe(
    second.preparation.receipt.sessionId,
  );
  expect(
    first.events.getOrdinarySessionPreparation(first.preparation!.receipt.allocationOperationId)
      ?.firstCommandId,
  ).toBe(first.request.clientMsgId);
  expect(
    first.events.getOrdinarySessionPreparation(second.preparation.receipt.allocationOperationId)
      ?.firstCommandId,
  ).toBe(second.request.clientMsgId);
  await expect(
    secondOwner.admitPreparedFirst(
      first.preparation!.receipt.allocationOperationId,
      second.request,
    ),
  ).rejects.toThrow();
  firstTurn.admission.assertCurrentSync();
  secondTurn.admission.assertCurrentSync();
  await expect(
    firstOwner.admitPreparedFirst(first.preparation!.receipt.allocationOperationId, first.request),
  ).resolves.toEqual({ dispatched: false });
  expect(first.dispatch).toHaveBeenCalledOnce();
  expect(second.dispatch).toHaveBeenCalledOnce();
});

import { createHash } from 'node:crypto';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
it('delivers retained Telos mandate and reviewed context in the actual silent-prepared Local packet', async () => {
  const f = await fixture({ silentPreparation: true });
  const sessionId = f.reservation.conversationId;
  const binding = f.events.getSession(sessionId)!.accountBinding!;
  const text = 'Host-reviewed lead item';
  retainTelosWorkRoleContext(f.events, sessionId, binding, {
    version: 1,
    itemId: 'item',
    role: 'lead',
    brief: { revision: 'reviewed', text, sha256: createHash('sha256').update(text).digest('hex') },
    parentCriteria: [],
    overallGoal: { itemId: 'item', revision: 'reviewed', text: 'Reviewed goal' },
    sources: [],
    artifacts: [],
  });
  await f.create().admitPreparedFirst(f.preparation!.receipt.allocationOperationId, f.request);
  expect(f.dispatch.mock.calls[0][0].payload.systemPrompt).toContain(
    'Child execution requires a separate worker conversation',
  );
  expect(f.dispatch.mock.calls[0][0].payload.systemPrompt).toContain(text);
});
it('denies malformed retained Telos context before the silent-prepared Local packet dispatch', async () => {
  const f = await fixture({ silentPreparation: true });
  f.events.append(f.reservation.conversationId, 'telos_work_role_context', {
    version: 1,
    selection: { role: 'lead' },
  });
  await expect(
    f.create().admitPreparedFirst(f.preparation!.receipt.allocationOperationId, f.request),
  ).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
});
it('preserves Telos role guidance when an ordinary Local continuation selects another supported model', async () => {
  const f = await fixture({ silentPreparation: true });
  f.configuration[0].models.push({
    id: 'future-model',
    label: 'Future',
    reasoningEfforts: ['low'],
  });
  f.writeProfiles();
  f.request.capabilityRevision = new OrdinaryLocalCodexCapabilityCatalog(
    loadAccountProfiles(),
    new OrdinaryLocalCodexHostRuntime(f.dependencies.env).target(),
    'ordinary',
  ).inventory().capabilityRevision;
  const rpc = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementation(async (method) =>
    method === 'model/list'
      ? {
          data: ['fixture-model', 'future-model'].map((model) => ({
            model,
            displayName: model,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          })),
          nextCursor: null,
        }
      : rpc(method),
  );
  const sessionId = f.reservation.conversationId;
  const binding = f.events.getSession(sessionId)!.accountBinding!;
  const text = 'Reviewed context survives inference choice';
  retainTelosWorkRoleContext(f.events, sessionId, binding, {
    version: 1,
    itemId: 'item',
    role: 'lead',
    brief: { revision: 'reviewed', text, sha256: createHash('sha256').update(text).digest('hex') },
    parentCriteria: [],
    overallGoal: { itemId: 'item', revision: 'reviewed', text: 'Goal' },
    sources: [],
    artifacts: [],
  });
  const continuation = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
    value.admission.assertBeforeEnqueue({
      id: value.commandId,
      prompt: value.payload.text,
      model: value.expected.selection.model,
      reasoningEffort: value.expected.selection.thinking,
    });
  });
  const driver = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    dispatchContinuation: continuation,
  });
  cleanups.push(() => driver.close());
  await driver.admitPreparedFirst(f.preparation!.receipt.allocationOperationId, f.request);
  const next = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    selection: { ...f.request.selection, model: 'future-model' },
    payload: { text: 'Continue using supported model' },
  };
  await expect(driver.admitContinuation(next)).resolves.toEqual({ dispatched: true });
  expect(continuation).toHaveBeenCalledOnce();
  const packet = continuation.mock.calls[0][0];
  expect(packet.payload.systemPrompt).toBe(f.dispatch.mock.calls[0][0].payload.systemPrompt);
  expect(packet.payload.systemPrompt).toContain(text);
  expect(packet.expected.selection.model).toBe('future-model');
  expect(packet.workspace.id).toBe(f.dispatch.mock.calls[0][0].workspace.id);
  expect(packet.lease.binding).toEqual(binding);
  expect(f.events.getSession(sessionId)?.accountBinding).toEqual(binding);
});

it.each([
  { tools: [], prepared: false },
  { tools: [{ id: 'mitzo:Read', version: 1 }], prepared: false },
  { tools: [], prepared: true },
  { tools: [{ id: 'mitzo:Read', version: 1 }], prepared: true },
] satisfies { tools: AgentToolReference[]; prepared: boolean }[])(
  'admits the published explicit selection through the actual owned runtime on first command and cold resume: %j',
  async ({ tools, prepared }) => {
    const f = await fixture({ tools, silentPreparation: prepared });
    const first = f.create();
    await expect(
      prepared ? first.admitPreparedFirst('allocation', f.request) : first.admit(f.request),
    ).resolves.toEqual({ dispatched: true });
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
      'consumed',
    );
    const original = f.dispatch.mock.calls[0][0];
    expect(original.expected.agentProfile?.definition.tools).toEqual(tools);
    expect(original.payload.systemPrompt).toContain('Preserve task ownership.');
    const native = new CodexConversationStore(join(f.root, 'selected-native.db'));
    cleanups.push(() => native.close());
    native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
    original.admission.persistCustody(native);
    native.bindThread(original.sessionId, original.lease.binding, 'selected-retained-thread');
    first.close();
    const next = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: { text: 'Continue with the published selection' },
    };
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      expect(value.expected.agentProfile).toEqual(original.expected.agentProfile);
      expect(value.expected.agentProfile?.definition.tools).toEqual(tools);
      value.admission.assertOptions({
        conversationId: value.sessionId,
        messageId: value.commandId,
        binding: value.lease.binding,
        profile: value.profile,
        session: { cwd: value.expected.workspace.cwd, mode: 'agent' },
        prompt: value.payload.text,
        systemPrompt: value.payload.systemPrompt,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        repositoryWorkspace: value.workspace,
        resume: true,
      });
    });
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      commandId: next.clientMsgId,
      launch: () => f.rpc,
      dispatch,
    });
    cleanups.push(() => cold.close());
    await expect(cold.admitResume(next)).resolves.toEqual({ dispatched: true });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(native.read(original.sessionId, original.lease.binding).threadId).toBe(
      'selected-retained-thread',
    );
  },
);

it('refuses unsupported published tools through actual owned profile resolution before native startup', async () => {
  const f = await fixture({ tools: [{ id: 'mitzo:GetConnectionGuide', version: 1 }] });
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.rpc.request).not.toHaveBeenCalled();
});

it('continues the same native thread from a new signed login after a compatible deployment, without replacing original custody', async () => {
  const f = await fixture({
    continuityV2: true,
    chatRoute: true,
    localRepository: true,
    realPreparationAuthority: true,
  });
  const first = f.create();
  await first.admit(f.request);
  const original = f.dispatch.mock.calls[0][0];
  const native = new CodexConversationStore(join(f.root, 'native-continuity.db'));
  cleanups.push(() => native.close());
  native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
  original.admission.persistCustody(native);
  native.bindThread(original.sessionId, original.lease.binding, 'same-native-thread');
  const custody = native.readHostCustody(original.sessionId, original.lease.binding);
  const bound = f.events.getSessionRuntimeBinding(original.sessionId);
  first.close();
  const actual = await vi.importActual<
    typeof import('../connections/reviewed-handler-artifacts.js')
  >('../connections/reviewed-handler-artifacts.js');
  manifest.artifacts = {
    ...actual.reviewedHandlerSourceArtifacts,
    '../unrelated-change.ts': 'e'.repeat(64),
  };
  const env = f.dependencies.env!;
  const targetPath = env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE!;
  const target = JSON.parse(readFileSync(targetPath, 'utf8'));
  const nativeSettings = JSON.parse(
    readFileSync(env.MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE!, 'utf8'),
  );
  const { ordinaryLocalCodexHostContractRevision } =
    await import('../ordinary-local-codex-host-runtime.js');
  target.runtimeContractRevision = ordinaryLocalCodexHostContractRevision(
    nativeSettings.executableSha256,
    nativeSettings.codeModeHostSha256,
  );
  writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600 });
  const web = await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!);
  if (!web) throw Error('Fixture login failed');
  const connection = randomUUID();
  cleanups.push(bindAgentLibraryTransport(connection, web), () => revokeAuthSession(web));
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    loadAccountProfiles(),
    new OrdinaryLocalCodexHostRuntime(env).target(),
    'ordinary',
  );
  const next = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    capabilityRevision: catalog.inventory().capabilityRevision,
    payload: { text: 'Continue on web' },
  };
  const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
    expect(value.resume).toBe(true);
    expect(value.expected.binding).toEqual(bound);
    expect(value.expected.workspace).toEqual(original.expected.workspace);
    value.admission.persistCustody(native);
  });
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    operatorConnectionId: connection,
    commandId: next.clientMsgId,
    nativeStore: native,
    launch: () => f.rpc,
    dispatch,
  });
  cleanups.push(() => cold.close());
  await expect(cold.admitResume(next)).resolves.toEqual({ dispatched: true });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(native.read(original.sessionId, original.lease.binding).threadId).toBe(
    'same-native-thread',
  );
  expect(native.readHostCustody(original.sessionId, original.lease.binding)).toEqual(custody);
  expect(f.events.getSessionRuntimeBinding(original.sessionId)).toEqual(bound);
  await expect(cold.admitResume(next)).resolves.toEqual({ dispatched: false });
  expect(dispatch).toHaveBeenCalledOnce();
});

it('commits a retained legacy companion upgrade in the native owner before launch and keeps the original thread', async () => {
  const f = await fixture();
  const first = f.create();
  await first.admit(f.request);
  const original = f.dispatch.mock.calls[0][0];
  const captured = original.lease.custodySnapshot!();
  const { codeModeHost, ...legacyExecutable } = captured.executable;
  expect(codeModeHost).toBeDefined();
  const custody = {
    version: 1 as const,
    authSessionId: f.auth.id,
    bootstrapId: original.expected.bootstrapId!,
    login: captured.login,
    executable: legacyExecutable,
  };
  const native = new CodexConversationStore(join(f.root, 'legacy-native.db'));
  cleanups.push(() => native.close());
  native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
  native.setHostCustody(original.sessionId, original.lease.binding, custody);
  native.bindThread(original.sessionId, original.lease.binding, 'legacy-thread');
  first.close();
  unlinkSync(codeModeHost!.path);
  const next = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Continue legacy bundle' },
  };
  const launch = vi.fn(() => {
    expect(
      native.readHostCustody(original.sessionId, original.lease.binding)?.executable.codeModeHost,
    ).toBeDefined();
    return f.rpc;
  });
  const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) =>
    value.admission.persistCustody(native),
  );
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    commandId: next.clientMsgId,
    nativeStore: native,
    launch,
    dispatch,
  });
  cleanups.push(() => cold.close());
  await expect(cold.admitResume(next)).resolves.toEqual({ dispatched: true });
  expect(launch).toHaveBeenCalledOnce();
  expect(native.read(original.sessionId, original.lease.binding).threadId).toBe('legacy-thread');
  const completed = native.readHostCustody(original.sessionId, original.lease.binding)!;
  const { codeModeHost: helper, ...main } = completed.executable;
  expect({ ...completed, executable: main }).toEqual(custody);
  expect(helper?.path).toBe(codeModeHost!.path);
});

it('does not invent an adoption or open a second transport when the real repository selector has no completed Prepare candidate', async () => {
  const f = await fixture();
  const native = new CodexConversationStore(join(f.root, 'transition-native.db'));
  cleanups.push(() => native.close());
  native.create(f.reservation.conversationId, f.reservation.binding, f.reserved.directory!);
  const runtime = new OrdinaryLocalCodexOwnedRuntime({ ...f.dependencies, nativeStore: native });
  cleanups.push(() => runtime.close());
  await runtime.admit(f.request);
  const admission = f.dispatch.mock.calls[0][0].admission;
  const scope = Object.freeze({
    bindingRevision: 'binding',
    profileRevision: 'profile',
    policyRevision: 'policy',
    readableRoots: Object.freeze(['/']),
    workspaceRoots: Object.freeze([]),
    deniedRoots: Object.freeze([]),
    signal: f.signal.signal,
    assertCurrentSync() {},
    async revalidate() {},
  });
  const policyOwner = Object.freeze({
    signal: f.signal.signal,
    selectedPolicy: () => {
      throw Error('No candidate must not create physical owner');
    },
    assertCurrentSync() {},
  });
  const target = Object.freeze({
    commandId: f.request.clientMsgId,
    attempt: 1,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  });
  await expect(
    admission.adoptPreparedRepositoryAtBoundary(scope, target, () => {}, policyOwner),
  ).resolves.toBeUndefined();
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.events.getLatestOrdinaryCommandAdmission(f.reservation.conversationId)?.state).toBe(
    'consumed',
  );
});
