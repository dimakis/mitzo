import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountBindingSchema,
  type SeatConfig,
  type SymposiumConfig,
  type SymposiumMembershipRecord,
  type SymposiumAdmissionRecord,
} from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import {
  admitSymposiumSeatDispatch,
  symposiumSeatRuntimeId,
  type SymposiumDispatchFacts,
} from '../symposium-seat-runtime.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
import { initializeSymposiumNativeHost } from '../symposium-native-host.js';
import { SymposiumOpenShellSeatExecutor } from '../symposium-openshell-seat-executor.js';
import {
  createOpenAiCodexSeat,
  assertCodexControllerCommand,
  SYMPOSIUM_CODEX_CONTROLLER_COMMAND,
} from '../symposium-codex-native.js';
import {
  snapshotSymposiumProviderUnion,
  SymposiumSharedSandboxOwner,
  createOpenShellProviderIdentityResolver,
  createSymposiumSessionRuntime,
} from '../symposium-session-runtime.js';

const profiles = new AccountProfiles([
  {
    id: 'work-api',
    label: 'Work OpenAI',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
    sandboxProvider: 'openai-work',
    sandboxProviderId: 'openai-object',
    models: [{ id: 'gpt-test', label: 'Test' }],
  },
  {
    id: 'work-vertex',
    label: 'Work Claude',
    provider: 'anthropic-vertex',
    projectId: 'work-project',
    region: 'us-east5',
    credentialRef: '/host/adc.json',
    sandboxProvider: 'vertex-work',
    sandboxProviderId: 'vertex-object',
    models: [{ id: 'claude-test', label: 'Test' }],
  },
]);
const hostGrants = { verifySeat: () => undefined };
const seat = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  model: 'gpt-test',
  systemPrompt: 'Review only.',
  color: '#223344',
  accountBinding: AccountBindingSchema.parse(profiles.resolve('work-api', 'gpt-test')),
  profileBinding: { profileId: 'reviewer', profileRevision: 'p1' },
  contextGrant: {
    grantId: 'context',
    revision: 1,
    classification: 'work' as const,
    sourceRefs: [],
  },
  authorityGrant: {
    grantId: 'authority',
    revision: 1,
    filesystem: 'read' as const,
    tools: 'read' as const,
    network: 'restricted' as const,
  },
  isolationRequest: {
    trustDomainId: 'shared',
    revision: 1,
    placement: 'reuse-compatible' as const,
  },
} satisfies SeatConfig;
const config: SymposiumConfig = {
  version: 2,
  revision: 4,
  state: 'active',
  anchorSeatId: 'reviewer',
  activeSeatCap: 3,
  seats: [seat],
  turnRules: { mode: 'directed', maxTurns: 10 },
  interceptMode: 'manual',
};
const membership = {
  sessionId: 'symposium',
  seatId: 'reviewer',
  generation: 2,
  state: 'active' as const,
  action: 'restore' as const,
  configRevision: 4,
  bindingKey: 'key',
  actor: 'director',
  reason: 'approved',
  idempotencyKey: 'restore-2',
  occurredAt: 1,
  reconciliation: 'confirmed' as const,
  replacesSeatId: null,
  replacedBySeatId: null,
};
const admission: SymposiumAdmissionRecord = {
  admissionId: 'a',
  sessionId: 'symposium',
  seatId: 'reviewer',
  membershipGeneration: 2,
  decision: 'admitted',
  reason: null,
  idempotencyKey: 'admit-2',
  configRevision: 4,
  provider: 'openai',
  accountId: 'work-api',
  model: 'gpt-test',
  accountProfileRevision: seat.accountBinding.profileRevision,
  isolationDomainId: 'shared',
  isolationDomainRevision: 1,
  decidedAt: 1,
};
function fixture() {
  let currentMembership: SymposiumMembershipRecord = { ...membership };
  let currentAdmission = { ...admission };
  let currentConfig = config;
  const delivery = {
    sessionId: 'symposium',
    status: 'delivering',
    deliveredContent: 'Only this approved excerpt.',
    recipients: [
      {
        seatId: 'reviewer',
        status: 'executing',
        idempotencyKey: 'attempt-1',
        membershipGeneration: 2,
      },
    ],
  };
  const facts: SymposiumDispatchFacts = {
    getActiveSymposiumConfig: () => currentConfig,
    getLatestSymposiumMembership: () => currentMembership,
    getLatestSymposiumAdmission: () => currentAdmission,
    getSymposiumDelivery: () => delivery,
  };
  const input: SymposiumSeatExecution = {
    sessionId: 'symposium',
    deliveryId: 'delivery-1',
    seat,
    content: 'Only this approved excerpt.',
    idempotencyKey: 'attempt-1',
    claimToken: 'claim-1',
    provenance: {
      version: 2,
      seatId: 'reviewer',
      configRevision: 4,
      accountProfileRevision: seat.accountBinding.profileRevision,
      seatProfileRevision: 'p1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'shared',
      isolationDomainRevision: 1,
      membershipGeneration: 2,
      capturedAt: 1,
      seatLabel: 'Reviewer',
      seatRole: 'reviewer',
      accountBinding: seat.accountBinding,
      reasoningEffort: null,
      profileBinding: seat.profileBinding,
      contextGrant: { grantId: 'context', revision: 1 },
      authorityGrant: { grantId: 'authority', revision: 1 },
    },
    signal: new AbortController().signal,
  };
  return {
    facts,
    input,
    setMembership: (next: SymposiumMembershipRecord) => {
      currentMembership = next;
    },
    setAdmission: (next: SymposiumAdmissionRecord) => {
      currentAdmission = next;
    },
    setConfig: (next: SymposiumConfig) => {
      currentConfig = next;
    },
  };
}

const registryDirectories: string[] = [];
afterEach(() => {
  for (const directory of registryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function registryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'symposium-executor-'));
  registryDirectories.push(directory);
  return directory;
}

describe('last native Symposium dispatch fence', () => {
  it.each(['admission', 'setup', 'initialization'])(
    'confirms a never-launched claim after %s failure, including host restart',
    async (failure) => {
      const work = fixture();
      const directory = registryDirectory();
      const host = initializeSymposiumNativeHost(directory);
      const deps = {
        facts: work.facts,
        profiles,
        attemptRegistry: host.registry,
        hostGrants: {
          verifySeat: () => {
            if (failure === 'admission') throw new Error('Setup failed');
          },
        },
        owner: {
          ensure: async () => {
            if (failure === 'setup') throw new Error('Setup failed');
            return { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' };
          },
          readOnlyEnforced: { openaiApi: true, claudeVertex: false },
        },
        recordAccepted: () => true,
        openNative: vi.fn(async () => {
          throw new Error('Setup failed');
        }),
      };
      await expect(new SymposiumOpenShellSeatExecutor(deps).execute(work.input)).rejects.toThrow(
        'Setup failed',
      );
      host.registry.close();
      const restarted = initializeSymposiumNativeHost(directory);
      expect(restarted.quarantinedClaims).toEqual([]);
      const executor = new SymposiumOpenShellSeatExecutor({
        ...deps,
        attemptRegistry: restarted.registry,
      });
      await expect(executor.cancel({ claimToken: work.input.claimToken })).resolves.toBeUndefined();
      expect(() =>
        restarted.registry.reserve({
          claimToken: work.input.claimToken,
          sessionId: work.input.sessionId,
          sandbox: { sandboxName: 'shared', workdir: '/work' },
        }),
      ).toThrow(/closed/);
      await expect(executor.cancel({ claimToken: 'unknown' })).rejects.toThrow(/unavailable/);
      restarted.registry.close();
    },
  );

  it('recovers a launched claim after restart only with exact controller cleanup proof', async () => {
    const work = fixture();
    const directory = registryDirectory();
    const host = initializeSymposiumNativeHost(directory);
    const sandbox = { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' };
    host.registry.prepare(work.input);
    // reserve is the durable pre-side-effect boundary; a crash here is uncertain.
    host.registry.reserve({ ...work.input, sandbox });
    host.registry.close();
    const restarted = initializeSymposiumNativeHost(directory);
    expect(restarted.quarantinedClaims).toEqual([work.input.claimToken]);
    expect(restarted.registry.get(work.input.claimToken)?.state).toBe('uncertain');
    restarted.registry.close();
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new Error('Observer unavailable'))
      .mockResolvedValueOnce(undefined);
    const registry = new SymposiumAttemptRegistry(join(directory, 'claims.db'), {
      launch: vi.fn(),
      confirm,
    });
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      attemptRegistry: registry,
      owner: { ensure: vi.fn(), readOnlyEnforced: { openaiApi: true, claudeVertex: false } },
      recordAccepted: () => true,
      openNative: vi.fn(),
    });
    await expect(executor.cancel({ claimToken: work.input.claimToken })).rejects.toThrow(
      /quarantined/,
    );
    expect(() => registry.assertSandboxAvailable(sandbox.sandboxName)).toThrow(/quarantined/);
    await expect(executor.cancel({ claimToken: work.input.claimToken })).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith(sandbox, work.input.claimToken);
    expect(() => registry.assertSandboxAvailable(sandbox.sandboxName)).not.toThrow();
    registry.close();
  });

  it('prevents setup from launching after a concurrent prelaunch cancellation', async () => {
    const work = fixture();
    const host = initializeSymposiumNativeHost(registryDirectory());
    let finish!: (value: { sandboxName: string; workdir: string }) => void;
    const openNative = vi.fn();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      attemptRegistry: host.registry,
      owner: {
        ensure: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: () => true,
      openNative,
    });
    const running = executor.execute(work.input);
    await executor.cancel({ claimToken: work.input.claimToken });
    finish({ sandboxName: 'shared', workdir: '/work' });
    await expect(running).rejects.toThrow(/cancelled/);
    expect(openNative).not.toHaveBeenCalled();
    host.registry.close();
  });

  it('rechecks the host grant after sandbox setup and records only exact accepted turns', async () => {
    const work = fixture();
    let permitted = true;
    const verifySeat = vi.fn(() => {
      if (!permitted) throw new Error('Host grant revoked');
    });
    const receipts: Array<Record<string, unknown>> = [];
    const run = vi.fn(async (_input, callbacks) => {
      callbacks.beforeDispatch();
      callbacks.accepted('thread-1', 'turn-1');
      return { providerThreadId: 'thread-1', content: 'reviewed' };
    });
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants: { verifySeat },
      owner: {
        ensure: async () => ({ sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: (input) => {
        receipts.push(input);
        return true;
      },
      openNative: async () => ({ run, cancel: async () => undefined }),
    });
    await expect(executor.execute(work.input)).resolves.toMatchObject({
      providerThreadId: 'thread-1',
      content: 'reviewed',
    });
    expect(receipts).toEqual([
      {
        deliveryId: 'delivery-1',
        seatId: 'reviewer',
        claimToken: 'claim-1',
        providerThreadId: 'thread-1',
        providerTurnId: 'turn-1',
        acceptedAt: expect.any(Number),
      },
    ]);
    permitted = false;
    await expect(executor.execute({ ...work.input, claimToken: 'claim-2' })).rejects.toThrow(
      'Host grant revoked',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('opens an independent Codex thread and accepts only its actual routed prompt', async () => {
    const work = fixture();
    const profiled = {
      ...work.input,
      seat: {
        ...work.input.seat,
        expectedOutput: 'A focused review',
        acceptanceCriteria: ['Cite each finding', 'Name remaining risk'],
      },
    };
    let options: Record<string, unknown> | undefined;
    const sent: Array<Record<string, unknown>> = [];
    const controllerProof = vi.fn().mockResolvedValue(undefined);
    const native = await createOpenAiCodexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
      execution: profiled,
      store: {} as never,
      testConfirmStopped: controllerProof,
      createConversation: (opts) => {
        options = opts as unknown as Record<string, unknown>;
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-1',
          send: async (command) => {
            sent.push(command);
            (opts.onProviderDispatch as (id: string) => void)(command.id);
            (opts.onProviderAccepted as (id: string, thread: string, turn: string) => void)(
              command.id,
              'thread-1',
              'turn-1',
            );
            (opts.emit as (event: Record<string, unknown>) => void)({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'specific review' }] },
            });
            (opts.onProviderComplete as (id: string, status: string) => void)(
              command.id,
              'completed',
            );
          },
          interrupt: async () => undefined,
          close: () => undefined,
        };
      },
    });
    const accepted: string[] = [];
    const result = await native.run(profiled, {
      beforeDispatch: () => accepted.push('dispatch'),
      accepted: (_thread, turn) => accepted.push(turn),
    });
    expect(sent).toEqual([
      expect.objectContaining({
        id: work.input.claimToken,
        prompt: 'Only this approved excerpt.',
        model: 'gpt-test',
      }),
    ]);
    expect(accepted).toEqual(['dispatch', 'turn-1']);
    expect(result).toEqual({ providerThreadId: 'thread-1', content: 'specific review' });
    expect(options?.conversationId).toBe(symposiumSeatRuntimeId(work.input));
    expect(options?.systemPrompt).toBe(
      'Review only.\n\nExpected output:\nA focused review\n\nAcceptance criteria:\n- Cite each finding\n- Name remaining risk',
    );
    expect(options?.turnSandboxPolicy).toEqual({ type: 'readOnly' });
    expect(options?.runtimeConfig).toEqual({
      web_search: 'disabled',
      'features.use_legacy_landlock': true,
    });
    expect(controllerProof).toHaveBeenCalledOnce();
  });
  it('refuses the real Codex transport without an attested controller command', async () => {
    const work = fixture();
    await expect(
      createOpenAiCodexSeat({
        sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
        route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
        execution: work.input,
        store: {} as never,
      }),
    ).rejects.toThrow(/controller capability is unavailable/);
  });
  it('pins the controller to the direct reviewed app-server argv', () => {
    expect(SYMPOSIUM_CODEX_CONTROLLER_COMMAND[0]).toBe('/usr/bin/codex');
    expect(() => assertCodexControllerCommand(SYMPOSIUM_CODEX_CONTROLLER_COMMAND)).not.toThrow();
    expect(() => assertCodexControllerCommand(['/sandbox/run-mitzo-app-server'])).toThrow(
      /reviewed API launcher/,
    );
    expect(() =>
      assertCodexControllerCommand([...SYMPOSIUM_CODEX_CONTROLLER_COMMAND, 'extra']),
    ).toThrow(/reviewed API launcher/);
  });
  it('keeps native cleanup reserved after transport loss until the exact turn terminates', async () => {
    const work = fixture();
    let complete: (id: string, status: 'failed') => void = () => undefined;
    let terminal: (id: string, turn: string, status: 'interrupted') => void = () => undefined;
    const controllerProof = vi.fn().mockResolvedValue(undefined);
    const native = await createOpenAiCodexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
      execution: work.input,
      store: {} as never,
      testConfirmStopped: controllerProof,
      createConversation: (opts) => {
        complete = (id, status) => opts.onProviderComplete?.(id, status);
        terminal = (id, turn, status) => opts.onProviderTerminal?.(id, turn, status);
        return {
          initialize: async () => undefined,
          getThreadId: () => 'thread-1',
          send: async (command) => {
            opts.onProviderDispatch?.(command.id);
            opts.onProviderAccepted?.(command.id, 'thread-1', 'turn-1');
          },
          interrupt: async () => undefined,
          close: () => undefined,
        };
      },
    });
    const run = native.run(work.input, {
      beforeDispatch: () => undefined,
      accepted: () => undefined,
    });
    complete(work.input.claimToken, 'failed');
    await expect(run).rejects.toThrow(/did not complete/);
    let settled = false;
    const cancel = native.cancel().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    terminal(work.input.claimToken, 'other-turn', 'interrupted');
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    terminal(work.input.claimToken, 'turn-1', 'interrupted');
    await expect(cancel).resolves.toBeUndefined();
    expect(controllerProof).toHaveBeenCalledOnce();
  });
  it('keeps Codex cleanup unconfirmed when the controller observer loses its marker', async () => {
    const work = fixture();
    const native = await createOpenAiCodexSeat({
      sandbox: { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' },
      route: admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants),
      execution: work.input,
      store: {} as never,
      testConfirmStopped: async () => {
        throw new Error('Native attempt cleanup is unconfirmed');
      },
      createConversation: (opts) => ({
        initialize: async () => undefined,
        getThreadId: () => 'thread-1',
        send: async (command) => {
          opts.onProviderDispatch?.(command.id);
          opts.onProviderAccepted?.(command.id, 'thread-1', 'turn-1');
          opts.onProviderTerminal?.(command.id, 'turn-1', 'completed');
          opts.onProviderComplete?.(command.id, 'completed');
        },
        interrupt: async () => undefined,
        close: () => undefined,
      }),
    });
    await expect(
      native.run(work.input, { beforeDispatch: () => undefined, accepted: () => undefined }),
    ).rejects.toThrow(/cleanup is unconfirmed/);
    await expect(native.cancel()).rejects.toThrow(/cleanup is unconfirmed/);
  });
  it('pins a mixed OpenAI and Claude union but blocks attachment before private state isolation', async () => {
    const work = fixture();
    const claudeSeat = {
      ...seat,
      id: 'claude',
      name: 'Claude',
      role: 'implementer',
      model: 'claude-test',
      accountBinding: AccountBindingSchema.parse(profiles.resolve('work-vertex', 'claude-test')),
    };
    const mixed = {
      ...config,
      anchorSeatId: 'reviewer',
      seats: [seat, claudeSeat],
    } as SymposiumConfig;
    const facts = {
      ...work.facts,
      getActiveSymposiumConfig: () => mixed,
      getLatestSymposiumMembership: (_sessionId: string, seatId: string) =>
        seatId === 'claude'
          ? {
              ...membership,
              seatId: 'claude',
              bindingKey: JSON.stringify([
                claudeSeat.accountBinding,
                claudeSeat.profileBinding,
                undefined,
                claudeSeat.contextGrant,
                claudeSeat.authorityGrant,
                claudeSeat.isolationRequest,
              ]),
            }
          : membership,
      getLatestSymposiumAdmission: (_sessionId: string, seatId: string) =>
        seatId === 'claude'
          ? {
              ...admission,
              seatId: 'claude',
              provider: 'anthropic-vertex',
              accountId: 'work-vertex',
              model: 'claude-test',
              accountProfileRevision: claudeSeat.accountBinding.profileRevision,
            }
          : admission,
    };
    let vertexType = 'google-vertex-ai';
    const identities = (name: string) => ({
      name,
      id: name === 'vertex-work' ? 'vertex-object' : 'openai-object',
      type: name === 'vertex-work' ? vertexType : 'openai',
      workspace: 'default',
    });
    const union = snapshotSymposiumProviderUnion(
      'symposium',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    expect(union.owner).toEqual({ kind: 'api', provider: 'openai-work', model: 'gpt-test' });
    expect(union.bindings).toEqual([
      { name: 'openai-work', id: 'openai-object', type: 'openai' },
      { name: 'vertex-work', id: 'vertex-object', type: 'google-vertex-ai' },
    ]);
    expect(union.verify).not.toThrow();
    vertexType = 'openai';
    expect(() =>
      snapshotSymposiumProviderUnion(
        'symposium',
        facts,
        profiles,
        hostGrants,
        identities,
        'default',
      ),
    ).toThrow(/provider type/i);
    vertexType = 'google-vertex-ai';
    const owner = new SymposiumSharedSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: identities,
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: () => ({
        ensure: async () => {
          throw new Error('must not attach');
        },
      }),
    });
    await expect(owner.ensure('symposium', new AbortController().signal)).rejects.toThrow(
      /private Claude seat state isolation/i,
    );
    vertexType = 'another-provider-type';
    expect(union.verify).toThrow(/provider type/i);
  });
  it('blocks two Codex seats from sharing native HOME state before OS isolation is proved', async () => {
    const work = fixture();
    const secondSeat = { ...seat, id: 'builder', name: 'Builder', role: 'implementer' };
    const facts = {
      ...work.facts,
      getActiveSymposiumConfig: () => ({ ...config, seats: [seat, secondSeat] }),
      getLatestSymposiumMembership: (_sessionId: string, seatId: string) => ({
        ...membership,
        seatId,
      }),
      getLatestSymposiumAdmission: (_sessionId: string, seatId: string) => ({
        ...admission,
        seatId,
      }),
    } as SymposiumDispatchFacts;
    const owner = new SymposiumSharedSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: () => ({
        ensure: async () => {
          throw new Error('must not attach');
        },
      }),
    });
    await expect(owner.ensure('symposium', new AbortController().signal)).rejects.toThrow(
      /private native seat state isolation/i,
    );
  });
  it('serializes concurrent seat setup through one session-owned provider policy', async () => {
    const work = fixture();
    let inFlight = 0;
    let maxInFlight = 0;
    const configurations: Array<Record<string, unknown>> = [];
    const owner = new SymposiumSharedSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      managerFactory: (config) => {
        configurations.push(config as unknown as Record<string, unknown>);
        return {
          ensure: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            config.verifyAccountProviderUnion?.();
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return { sandboxName: 'shared', workdir: '/sandbox/workspaces/mgmt' };
          },
        };
      },
    });
    const signal = new AbortController().signal;
    await Promise.all([owner.ensure('symposium', signal), owner.ensure('symposium', signal)]);
    expect(maxInFlight).toBe(1);
    expect(configurations).toHaveLength(2);
    expect(configurations[0].accountProviderBindings).toEqual([
      { name: 'openai-work', type: 'openai', id: 'openai-object' },
    ]);
  });
  it('invalidates a cached provider union when the host account profile changes', () => {
    const work = fixture();
    let current = profiles;
    const union = snapshotSymposiumProviderUnion(
      'symposium',
      work.facts,
      () => current,
      hostGrants,
      (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      'default',
    );
    expect(union.verify).not.toThrow();
    current = new AccountProfiles([
      {
        id: 'work-api',
        label: 'Updated OpenAI',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'mitzo', account: 'updated' },
        sandboxProvider: 'openai-work',
        sandboxProviderId: 'openai-object',
        models: [{ id: 'gpt-test', label: 'Test' }],
      },
    ]);
    expect(union.verify).toThrow(/Account configuration changed/);
  });
  it('refuses an OpenAI account bound to a physical Vertex provider', () => {
    const work = fixture();
    expect(() =>
      snapshotSymposiumProviderUnion(
        'symposium',
        work.facts,
        profiles,
        hostGrants,
        (name, id) => ({ name, id, type: 'google-vertex-ai', workspace: 'default' }),
        'default',
      ),
    ).toThrow(/provider type/i);
  });
  it('refuses a claimed Claude read-only deployment without a verified native wrapper', () => {
    const work = fixture();
    expect(
      () =>
        new SymposiumSharedSandboxOwner({
          sessionId: 'symposium',
          facts: work.facts,
          profiles,
          hostGrants,
          resolveProviderIdentity: (name, id) => ({
            name,
            id,
            type: 'openai',
            workspace: 'default',
          }),
          runtimeConfig: {
            cli: 'openshell',
            image: 'image',
            policy: '/policy',
            seed: '/seed',
            serviceProviders: [],
            grantableServiceProviders: [],
            workspace: 'default',
            gateway: 'openshell',
            gatewayInsecure: false,
            createDetached: true,
            sandboxIdLength: 13,
            workdir: '/sandbox/workspaces/mgmt',
            webSearch: 'disabled',
          },
          readOnlyEnforced: { openaiApi: true, claudeVertex: true },
        }),
    ).toThrow(/Claude.*read-only/i);
  });
  it('loads actual gateway name, type, ID, and workspace without trusting account labels', () => {
    const resolve = createOpenShellProviderIdentityResolver(
      { cli: 'openshell', gateway: 'openshell', workspace: 'default', gatewayInsecure: false },
      () =>
        JSON.stringify([
          {
            name: 'openai-work',
            id: 'openai-object',
            type: 'openai',
            workspace: 'default',
            credential_keys: ['OPENAI_API_KEY'],
          },
        ]),
    );
    expect(resolve('openai-work', 'openai-object')).toEqual({
      name: 'openai-work',
      id: 'openai-object',
      type: 'openai',
      workspace: 'default',
    });
    expect(() => resolve('openai-work', 'replaced-id')).toThrow(/identity/i);
  });
  it('builds a runnable seat executor from one shared owner and exact receipt sink', async () => {
    const work = fixture();
    const accepted: string[] = [];
    const recordEvent = vi.fn();
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store: work.facts as never,
      recordEvent,
      profiles,
      hostGrants,
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        image: 'image',
        policy: '/policy',
        seed: '/seed',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace: 'default',
        gateway: 'openshell',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: '/sandbox/workspaces/mgmt',
        webSearch: 'disabled',
      },
      readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      recordAccepted: ({ providerTurnId }) => {
        accepted.push(providerTurnId);
        return true;
      },
      managerFactory: () => ({
        ensure: async () => ({
          sandboxName: 'shared',
          workdir: '/sandbox/workspaces/mgmt',
        }),
      }),
      openNative: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          callbacks.accepted('thread', 'turn');
          return { providerThreadId: 'thread', content: 'done' };
        },
        cancel: async () => undefined,
      }),
    });
    await expect(runtime.executors.reviewer.execute(work.input)).resolves.toEqual({
      providerThreadId: 'thread',
      content: 'done',
    });
    expect(accepted).toEqual(['turn']);
    expect(recordEvent).toHaveBeenCalledWith(work.input, { type: 'symposium_attempt_accepted' });
    expect(recordEvent).toHaveBeenCalledWith(work.input, { type: 'symposium_attempt_released' });
    expect(runtime.owner).toBeDefined();
  });
  it('requires a current host-issued grant at the native boundary', () => {
    const { facts, input } = fixture();
    const verifier = {
      verifySeat: vi.fn(() => {
        throw new Error('Host grant revoked');
      }),
    };
    expect(() => admitSymposiumSeatDispatch(facts, profiles, input, verifier)).toThrow(
      'Host grant revoked',
    );
    expect(verifier.verifySeat).toHaveBeenCalledWith({
      sessionId: input.sessionId,
      seat: input.seat,
      membershipGeneration: 2,
    });
  });
  it('binds the real recipient to an explicit account provider and read-only route', () => {
    const { facts, input } = fixture();
    expect(admitSymposiumSeatDispatch(facts, profiles, input, hostGrants)).toEqual({
      kind: 'openai-api',
      provider: 'openai-work',
      providerId: 'openai-object',
      model: 'gpt-test',
      effort: null,
      readOnly: true,
    });
  });
  it('rejects revocation or provider refusal that happens after the earlier claim', () => {
    const work = fixture();
    work.setMembership({
      ...membership,
      generation: 3,
      state: 'suspended',
      reconciliation: 'pending',
    });
    expect(() => admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants)).toThrow(
      /membership/i,
    );
    work.setMembership({ ...membership });
    work.setAdmission({ ...admission, decision: 'refused' });
    expect(() => admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants)).toThrow(
      /admission/i,
    );
  });
  it('rejects a prompt or recipient that differs from the durably approved delivery', () => {
    const { facts, input } = fixture();
    expect(() =>
      admitSymposiumSeatDispatch(
        facts,
        profiles,
        {
          ...input,
          content: 'Aggregate conversation the seat never received',
        },
        hostGrants,
      ),
    ).toThrow(/recipient delivery/i);
    expect(() =>
      admitSymposiumSeatDispatch(
        facts,
        profiles,
        {
          ...input,
          idempotencyKey: 'another-attempt',
        },
        hostGrants,
      ),
    ).toThrow(/recipient delivery/i);
  });
  it('refuses native budgeted dispatch until a trusted provider cost reservation exists', () => {
    const work = fixture();
    work.setConfig({ ...config, turnRules: { mode: 'budgeted', maxTurns: 3, budgetUsd: 1 } });
    expect(() => admitSymposiumSeatDispatch(work.facts, profiles, work.input, hostGrants)).toThrow(
      /cost reservation/i,
    );
  });
  it('never resumes the old native thread after restore or binding replacement', () => {
    const { input } = fixture();
    expect(symposiumSeatRuntimeId(input)).not.toBe(
      symposiumSeatRuntimeId({
        ...input,
        provenance: { ...input.provenance, membershipGeneration: 3 },
      }),
    );
    expect(symposiumSeatRuntimeId(input)).not.toBe(
      symposiumSeatRuntimeId({
        ...input,
        seat: { ...input.seat, authorityGrant: { ...seat.authorityGrant, revision: 2 } },
      }),
    );
  });
  it('routes a Vertex Claude seat without ever returning host ADC material', () => {
    const work = fixture();
    const claudeSeat = {
      ...seat,
      model: 'claude-test',
      accountBinding: AccountBindingSchema.parse(profiles.resolve('work-vertex', 'claude-test')),
    };
    work.setConfig({ ...config, seats: [claudeSeat] });
    work.setAdmission({
      ...admission,
      provider: 'anthropic-vertex',
      accountId: 'work-vertex',
      model: 'claude-test',
      accountProfileRevision: claudeSeat.accountBinding.profileRevision,
    });
    const route = admitSymposiumSeatDispatch(
      work.facts,
      profiles,
      {
        ...work.input,
        seat: claudeSeat,
        provenance: {
          ...work.input.provenance,
          accountBinding: claudeSeat.accountBinding,
          accountProfileRevision: claudeSeat.accountBinding.profileRevision,
        },
      },
      hostGrants,
    );
    expect(route).toMatchObject({
      kind: 'claude-vertex',
      provider: 'vertex-work',
      providerId: 'vertex-object',
    });
    expect(JSON.stringify(route)).not.toContain('/host/adc.json');
  });
});
