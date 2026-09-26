import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SymposiumSeatSandboxRecord } from '@mitzo/protocol/event-store';
import {
  AccountBindingSchema,
  type SeatConfig,
  type SymposiumConfig,
  type SymposiumMembershipRecord,
  type SymposiumAdmissionRecord,
} from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import {
  acquireSymposiumArtifactLease,
  type ArtifactAccess,
  type ArtifactLeaseRequest,
} from '../symposium-artifact-lease.js';
import {
  sandboxNameForConversation,
  type BoundOpenShellRuntimeConfig,
} from '../openshell-runtime.js';
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
  snapshotSymposiumSeatProvider,
  SymposiumSharedSandboxOwner,
  SymposiumPerSeatSandboxOwner,
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

function seatSandboxRegistry() {
  const rows = new Map<string, SymposiumSeatSandboxRecord>();
  const fences = new Map<string, string>();
  const key = (sessionId: string, seatId: string, generation: number) =>
    `${sessionId}:${seatId}:${generation}`;
  return {
    claimSymposiumSeatLifecycle(sessionId: string, seatId: string, token: string) {
      const id = `${sessionId}:${seatId}`;
      if (fences.has(id)) return false;
      fences.set(id, token);
      return true;
    },
    releaseSymposiumSeatLifecycle(sessionId: string, seatId: string, token: string) {
      const id = `${sessionId}:${seatId}`;
      if (fences.get(id) !== token) throw new Error('lifecycle fence changed');
      fences.delete(id);
    },
    reserveSymposiumSeatSandbox(
      input: Omit<
        SymposiumSeatSandboxRecord,
        'sandboxName' | 'physicalId' | 'creationStarted' | 'creationCompleted' | 'state'
      >,
    ) {
      const id = key(input.sessionId, input.seatId, input.generation);
      const existing = rows.get(id);
      if (existing) {
        if (
          existing.runtimeId !== input.runtimeId ||
          existing.state === 'stopped' ||
          (existing.creationStarted && !existing.creationCompleted)
        )
          throw new Error('reservation changed');
        return existing;
      }
      if (
        [...rows.values()].some(
          (row) =>
            row.sessionId === input.sessionId &&
            row.seatId === input.seatId &&
            row.state !== 'stopped',
        )
      )
        throw new Error('previous sandbox requires stop');
      const row: SymposiumSeatSandboxRecord = {
        ...input,
        sandboxName: null,
        physicalId: null,
        creationStarted: false,
        creationCompleted: false,
        state: 'reserved',
      };
      rows.set(id, row);
      return row;
    },
    markSymposiumSeatSandboxCreationStarted(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        row.creationStarted ||
        row.state !== 'reserved'
      )
        throw new Error('creation requires reconciliation');
      row.creationStarted = true;
    },
    markSymposiumSeatSandboxCreationCompleted(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        row.physicalId !== input.physicalId ||
        !row.creationStarted ||
        row.creationCompleted ||
        row.state !== 'ready'
      )
        throw new Error('completion changed');
      row.creationCompleted = true;
    },
    confirmSymposiumSeatSandbox(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      runtimeId: string;
      sandboxName: string;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.runtimeId !== input.runtimeId ||
        (row.physicalId && row.physicalId !== input.physicalId)
      )
        throw new Error('identity changed');
      row.sandboxName = input.sandboxName;
      row.physicalId = input.physicalId;
      row.state = 'ready';
    },
    getSymposiumSeatSandbox: (sessionId: string, seatId: string, generation: number) =>
      rows.get(key(sessionId, seatId, generation)),
    listUnstoppedSymposiumSeatSandboxes: (sessionId: string, seatId: string) =>
      [...rows.values()]
        .filter(
          (row) => row.sessionId === sessionId && row.seatId === seatId && row.state !== 'stopped',
        )
        .map((row) => ({ ...row })),
    confirmSymposiumSeatSandboxStopped(input: {
      sessionId: string;
      seatId: string;
      generation: number;
      physicalId: string;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (
        !row ||
        row.physicalId !== input.physicalId ||
        (row.creationStarted && !row.creationCompleted)
      )
        throw new Error('stop identity changed');
      row.state = 'stopped';
    },
    confirmAbsentSymposiumSeatSandboxStopped(input: {
      sessionId: string;
      seatId: string;
      generation: number;
    }) {
      const row = rows.get(key(input.sessionId, input.seatId, input.generation));
      if (!row || row.physicalId || row.creationStarted) throw new Error('absence changed');
      row.state = 'stopped';
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

  it('re-probes the exact host and provider immediately before native dispatch', async () => {
    const work = fixture();
    let available = true;
    const verifyHostCapability = vi.fn(() => {
      if (!available) throw new Error('Selected gateway capability changed');
      return { attestedProviderProfiles: new Set(['unrelated-provider']) };
    });
    const send = vi.fn();
    const executor = new SymposiumOpenShellSeatExecutor({
      facts: work.facts,
      profiles,
      hostGrants,
      verifyHostCapability,
      owner: {
        ensure: async () => ({ sandboxName: 'seat', workdir: '/sandbox/workspaces/mgmt' }),
        readOnlyEnforced: { openaiApi: true, claudeVertex: false },
      },
      recordAccepted: vi.fn(() => true),
      openNative: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          send();
          return { providerThreadId: 'thread-1', content: 'sent' };
        },
        cancel: async () => undefined,
      }),
    });
    await expect(executor.execute(work.input)).rejects.toThrow('outside the host attestation');
    expect(verifyHostCapability).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    available = false;
    await expect(executor.execute({ ...work.input, claimToken: 'claim-2' })).rejects.toThrow(
      'Selected gateway capability changed',
    );
    expect(send).not.toHaveBeenCalled();
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
    const openaiOnly = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    const vertexOnly = snapshotSymposiumSeatProvider(
      'symposium',
      'claude',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    expect(openaiOnly.bindings).toEqual([
      { name: 'openai-work', id: 'openai-object', type: 'openai' },
    ]);
    expect(vertexOnly.bindings).toEqual([
      { name: 'vertex-work', id: 'vertex-object', type: 'google-vertex-ai' },
    ]);
    expect(openaiOnly.runtimeId).not.toBe(vertexOnly.runtimeId);
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
  it('pins one attachment and one sandbox identity per confirmed seat', async () => {
    const work = fixture();
    const secondSeat = { ...seat, id: 'builder', name: 'Builder', role: 'implementer' };
    const facts: SymposiumDispatchFacts = {
      ...work.facts,
      getActiveSymposiumConfig: () => ({ ...config, seats: [seat, secondSeat] }),
      getLatestSymposiumMembership: (_sessionId, seatId) => ({ ...membership, seatId }),
      getLatestSymposiumAdmission: (_sessionId, seatId) => ({ ...admission, seatId }),
    };
    const identities = (name: string, id: string) => ({
      name,
      id,
      type: 'openai',
      workspace: 'default',
    });
    const first = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    const second = snapshotSymposiumSeatProvider(
      'symposium',
      'builder',
      facts,
      profiles,
      hostGrants,
      identities,
      'default',
    );
    expect(first.runtimeId).not.toBe(second.runtimeId);
    expect(first.bindings).toEqual([{ name: 'openai-work', type: 'openai', id: 'openai-object' }]);
    expect(second.bindings).toEqual(first.bindings);
    const configurations: Array<{ accountProviderBindings?: readonly { name: string }[] }> = [];
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: seatSandboxRegistry(),
      resolveProviderIdentity: identities,
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      managerFactory: (runtimeConfig) => {
        configurations.push(runtimeConfig);
        return {
          ensure: async (runtimeId) => ({
            sandboxName: runtimeId,
            sandboxId: `id:${runtimeId}`,
            workdir: '/sandbox/workspaces/mgmt',
          }),
        };
      },
    });
    const [a, b] = await Promise.all([
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
      owner.ensure('symposium', 'builder', new AbortController().signal),
    ]);
    expect(a.sandboxName).not.toBe(b.sandboxName);
    expect(configurations.map((value) => value.accountProviderBindings)).toEqual([
      first.bindings,
      second.bindings,
    ]);
  });
  it('quarantines a timed-out create even when an absence probe precedes late gateway creation', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    let gatewaySandbox: { id: string; name: string; phase: string } | undefined;
    let finishGatewayCreate: (() => void) | undefined;
    const gatewayCreate = new Promise<void>((resolve) => {
      finishGatewayCreate = () => {
        gatewaySandbox = { id: 'late-physical', name: 'late-seat', phase: 'Ready' };
        resolve();
      };
    });
    const ensure = vi.fn(async () => {
      // The CLI request times out while the gateway continues creating the sandbox.
      void gatewayCreate;
      throw new Error('gateway create timed out');
    });
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      managerFactory: () => ({
        ensure,
        inspectReserved: async () => gatewaySandbox,
        inspect: async () => gatewaySandbox,
        stop: async () => {
          throw new Error('uncertain create must not be stopped as settled');
        },
      }),
    });
    const signal = new AbortController().signal;
    await expect(owner.ensure('symposium', 'reviewer', signal)).rejects.toThrow(/timed out/);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
      state: 'reserved',
      creationStarted: true,
      creationCompleted: false,
    });
    await expect(owner.stop('symposium', 'reviewer', 2, signal)).rejects.toThrow(
      /may still complete/,
    );
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe('reserved');
    finishGatewayCreate!();
    await gatewayCreate;
    await expect(owner.stop('symposium', 'reviewer', 2, signal)).rejects.toThrow(/uncertain/);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
      state: 'ready',
      physicalId: 'late-physical',
      creationCompleted: false,
    });
    await expect(owner.ensure('symposium', 'reviewer', signal)).rejects.toThrow(
      /reservation changed/,
    );
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('re-probes host and exact provider before a queued sandbox reservation', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    const managerFactory = vi.fn(() => ({
      ensure: async () => ({
        sandboxName: 'seat',
        sandboxId: 'physical-seat',
        workdir: '/sandbox/workspaces/mgmt',
      }),
    }));
    const verifyHostCapability = vi.fn(() => ({
      attestedProviderProfiles: new Set(['unrelated-provider']),
    }));
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      verifyHostCapability,
      managerFactory,
    });
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).rejects.toThrow('outside the host attestation');
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toBeUndefined();
    expect(managerFactory).not.toHaveBeenCalled();
    expect(verifyHostCapability).toHaveBeenCalledTimes(1);
  });

  it('reuses the retained sandbox after a benign config revision but rejects a changed authority grant', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    const ensure = vi.fn(async (runtimeId: string) => ({
      sandboxName: runtimeId,
      sandboxId: `physical:${runtimeId}`,
      workdir: '/sandbox/workspaces/mgmt',
    }));
    const stopped: string[] = [];
    let phase = 'Ready';
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      managerFactory: () => ({
        ensure,
        inspectReserved: async () => undefined,
        inspect: async (_runtimeId, physicalId) => ({ id: physicalId, phase }),
        stop: async (runtimeId, physicalId) => {
          stopped.push(`${runtimeId}:${physicalId}`);
          phase = 'Stopped';
        },
      }),
    });
    const signal = new AbortController().signal;
    const first = await owner.ensure('symposium', 'reviewer', signal);
    const retained = registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;

    work.setConfig({ ...config, revision: 5 });
    work.setAdmission({ ...admission, configRevision: 5 });
    const second = await owner.ensure('symposium', 'reviewer', signal);
    expect(second).toEqual(first);
    expect(ensure).toHaveBeenCalledTimes(1);

    work.setConfig({
      ...config,
      revision: 6,
      seats: [{ ...seat, authorityGrant: { ...seat.authorityGrant!, revision: 2 } }],
    });
    work.setAdmission({ ...admission, configRevision: 6 });
    await expect(owner.ensure('symposium', 'reviewer', signal)).rejects.toThrow(
      /reservation changed/,
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    await owner.stop('symposium', 'reviewer', 2, signal);
    expect(stopped).toEqual([`${retained.runtimeId}:${retained.physicalId}`]);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe('stopped');
  });
  it('changes the sandbox identity when the physical provider binding changes', () => {
    const work = fixture();
    const identity = (name: string, id: string) => ({
      name,
      id,
      type: 'openai',
      workspace: 'default',
    });
    const first = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      work.facts,
      profiles,
      hostGrants,
      identity,
      'default',
    );
    const changedProfiles = new AccountProfiles([
      {
        id: 'work-api',
        label: 'Work OpenAI',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
        sandboxProvider: 'openai-work',
        sandboxProviderId: 'replacement-object',
        models: [{ id: 'gpt-test', label: 'Test' }],
      },
    ]);
    const replacementBinding = AccountBindingSchema.parse(
      changedProfiles.resolve('work-api', 'gpt-test'),
    );
    work.setConfig({
      ...config,
      revision: 5,
      seats: [{ ...seat, accountBinding: replacementBinding }],
    });
    work.setAdmission({
      ...admission,
      configRevision: 5,
      accountProfileRevision: replacementBinding.profileRevision,
    });
    const changed = snapshotSymposiumSeatProvider(
      'symposium',
      'reviewer',
      work.facts,
      changedProfiles,
      hostGrants,
      identity,
      'default',
    );
    expect(changed.runtimeId).not.toBe(first.runtimeId);
    expect(() => first.verify()).toThrow(/Account configuration changed/i);
  });
  it('admits a pending seat before attaching its verified provider, then requires admission', () => {
    let currentAdmission: SymposiumAdmissionRecord | undefined;
    let currentMembership: SymposiumMembershipRecord = {
      ...membership,
      reconciliation: 'pending',
    };
    const facts: SymposiumDispatchFacts = {
      getActiveSymposiumConfig: () => config,
      getLatestSymposiumMembership: () => currentMembership,
      getLatestSymposiumAdmission: () => currentAdmission,
      getSymposiumDelivery: () => undefined,
    };
    const identity = (name: string, id: string) => ({
      name,
      id,
      type: 'openai',
      workspace: 'default',
    });
    const snapshot = (phase: 'candidate' | 'reconciling' | 'confirmed') =>
      snapshotSymposiumSeatProvider(
        'symposium',
        'reviewer',
        facts,
        profiles,
        hostGrants,
        identity,
        'default',
        phase,
      );
    expect(snapshot('candidate').bindings).toEqual([
      { name: 'openai-work', id: 'openai-object', type: 'openai' },
    ]);
    expect(() => snapshot('reconciling')).toThrow(/admission/i);
    currentAdmission = { ...admission, decision: 'refused' };
    expect(() => snapshot('candidate')).toThrow(/admission/i);
    currentAdmission = { ...admission };
    expect(snapshot('reconciling').generation).toBe(2);
    expect(() => snapshot('confirmed')).toThrow(/membership/i);
    currentMembership = { ...membership };
    expect(snapshot('confirmed').generation).toBe(2);
    expect(() => snapshot('candidate')).toThrow(/membership/i);
  });
  it('does not create a pending seat sandbox until its provider admission is recorded', async () => {
    // The admission changes between the two ensure attempts in this test.
    let currentAdmission: SymposiumAdmissionRecord | undefined = undefined;
    const facts: SymposiumDispatchFacts = {
      getActiveSymposiumConfig: () => config,
      getLatestSymposiumMembership: () => ({ ...membership, reconciliation: 'pending' }),
      getLatestSymposiumAdmission: () => currentAdmission,
      getSymposiumDelivery: () => undefined,
    };
    const ensure = vi.fn(async (runtimeId: string) => ({
      sandboxName: runtimeId,
      sandboxId: `physical:${runtimeId}`,
      workdir: '/sandbox/workspaces/mgmt',
    }));
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: seatSandboxRegistry(),
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      managerFactory: () => ({ ensure }),
    });
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).rejects.toThrow(/admission/i);
    expect(ensure).not.toHaveBeenCalled();
    currentAdmission = { ...admission };
    await expect(
      owner.ensure('symposium', 'reviewer', new AbortController().signal),
    ).resolves.toMatchObject({ sandboxId: expect.stringMatching(/^physical:/) });
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  it('stops the recorded physical sandbox after seat configuration changes', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    const stopped: string[] = [];
    let phase = 'Ready';
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      seatSandboxRegistry: registry,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      managerFactory: () => ({
        ensure: async () => ({
          sandboxName: 'original',
          sandboxId: 'physical-1',
          workdir: '/sandbox/workspaces/mgmt',
        }),
        inspectReserved: async () => ({ id: 'physical-1', name: 'original', phase }),
        inspect: async (_runtimeId, physicalId) => {
          expect(physicalId).toBe('physical-1');
          return { id: physicalId, phase };
        },
        stop: async (runtimeId, physicalId) => {
          stopped.push(`${runtimeId}:${physicalId}`);
          phase = 'Stopped';
        },
      }),
    });
    await owner.ensure('symposium', 'reviewer', new AbortController().signal);
    const record = registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
    work.setConfig({ ...config, seats: [] });
    await owner.stop('symposium', 'reviewer', 3, new AbortController().signal);
    expect(stopped).toEqual([`${record.runtimeId}:physical-1`]);
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe('stopped');
    await owner.stop('symposium', 'reviewer', 3, new AbortController().signal);
    expect(stopped).toHaveLength(1);
  });
  it('keeps a late ensure quarantined until another worker physically stops it', async () => {
    const work = fixture();
    const registry = seatSandboxRegistry();
    let finishCreate!: () => void;
    let creationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const createGate = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    let phase = 'Ready';
    const stop = vi.fn(async () => {
      phase = 'Stopped';
    });
    const makeOwner = () =>
      new SymposiumPerSeatSandboxOwner({
        sessionId: 'symposium',
        facts: work.facts,
        profiles,
        hostGrants,
        seatSandboxRegistry: registry,
        resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
        runtimeConfig: {
          cli: 'openshell',
          cliContract: 'v0.1',
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
        perSeatSandboxVerified: true,
        managerFactory: () => ({
          ensure: async () => {
            creationStarted();
            await createGate;
            return {
              sandboxName: 'late-sandbox',
              sandboxId: 'late-physical',
              workdir: '/sandbox/workspaces/mgmt',
            };
          },
          inspectReserved: async () => ({ id: 'late-physical', name: 'late-sandbox', phase }),
          inspect: async () => ({ id: 'late-physical', phase }),
          stop,
        }),
      });
    const signal = new AbortController().signal;
    const create = makeOwner().ensure('symposium', 'reviewer', signal);
    await started;
    work.setConfig({ ...config, seats: [] });
    const stopping = makeOwner().stop('symposium', 'reviewer', 2, signal);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(stop).not.toHaveBeenCalled();
    finishCreate();
    await expect(create).rejects.toThrow(/no longer configured/);
    await stopping;
    expect(stop).toHaveBeenCalledOnce();
    expect(registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
      physicalId: 'late-physical',
      state: 'stopped',
    });
  });
  it('keeps seat attachment closed without a verified per-seat capability', async () => {
    const work = fixture();
    const ensure = vi.fn();
    const owner = new SymposiumPerSeatSandboxOwner({
      sessionId: 'symposium',
      facts: work.facts,
      profiles,
      hostGrants,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      managerFactory: () => ({ ensure }),
    });
    expect(() => owner.ensure('symposium', 'reviewer', new AbortController().signal)).toThrow(
      /not verified/,
    );
    expect(ensure).not.toHaveBeenCalled();
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
  it('reads the 0.1 paginated workspace provider inventory', () => {
    const requests: string[][] = [];
    const resolve = createOpenShellProviderIdentityResolver(
      {
        cli: 'openshell',
        cliContract: 'v0.1',
        gateway: 'openshell',
        workspace: 'default',
        gatewayInsecure: false,
      },
      (args) => {
        requests.push([...args]);
        return args.includes('--page-token')
          ? JSON.stringify({
              providers: [
                { name: 'openai-work', id: 'openai-object', type: 'openai', workspace: 'default' },
              ],
              next_page_token: '',
            })
          : JSON.stringify({ providers: [], next_page_token: 'next' });
      },
    );
    expect(resolve('openai-work', 'openai-object').id).toBe('openai-object');
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(
      expect.arrayContaining(['--workspace', 'default', '--page-token', 'next']),
    );
  });
  it('passes the page token to the default CLI runner', () => {
    const spawn = vi.fn((_cli: string, args: readonly string[]) => ({
      status: 0,
      stdout: args.includes('--page-token')
        ? JSON.stringify({
            providers: [
              { name: 'openai-work', id: 'openai-object', type: 'openai', workspace: 'default' },
            ],
            next_page_token: '',
          })
        : JSON.stringify({ providers: [], next_page_token: 'next' }),
    }));
    const resolve = createOpenShellProviderIdentityResolver(
      {
        cli: 'openshell',
        cliContract: 'v0.1',
        gateway: 'openshell',
        workspace: 'default',
        gatewayInsecure: false,
      },
      undefined,
      spawn as unknown as typeof import('node:child_process').spawnSync,
    );
    expect(resolve('openai-work', 'openai-object').id).toBe('openai-object');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['--page-token', 'next']));
  });
  it('builds a runnable seat executor from one shared owner and exact receipt sink', async () => {
    const work = fixture();
    const accepted: string[] = [];
    const runtime = createSymposiumSessionRuntime({
      sessionId: 'symposium',
      store: { ...work.facts, ...seatSandboxRegistry() } as never,
      profiles,
      hostGrants,
      codexStore: {} as never,
      resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
      runtimeConfig: {
        cli: 'openshell',
        cliContract: 'v0.1',
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
      perSeatSandboxVerified: true,
      recordAccepted: ({ providerTurnId }) => {
        accepted.push(providerTurnId);
        return true;
      },
      managerFactory: () => ({
        ensure: async () => ({
          sandboxName: 'shared',
          sandboxId: 'physical-shared',
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

describe('per-seat artifact admission', () => {
  function setup(
    access: ArtifactAccess,
    options: {
      failMount?: boolean;
      failCreate?: boolean;
      failDriverConfig?: boolean;
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'symposium-owner-artifact-'));
    const request: ArtifactLeaseRequest = {
      sessionId: 'symposium',
      workspaceId: 'default',
      seatId: 'reviewer',
      volumeName: 'symposium-artifacts',
      volumeGeneration: 'gen-1',
      driver: 'podman',
      access,
    };
    const labels = {
      'openshell.ai/sandbox-attachable': 'true',
      'openshell.ai/sandbox-attachable-workspace': 'default',
      'mitzo.symposium.purpose': 'artifacts',
      'mitzo.symposium.session': 'symposium',
      'mitzo.symposium.workspace': 'default',
      'mitzo.symposium.generation': 'gen-1',
    };
    const verifyMount = vi.fn(async () => {
      if (options.failMount) throw new Error('physical mount mismatch');
    });
    const verifyDeleted = vi.fn(async () => {});
    const host = new SqliteArtifactLeaseHost(
      join(root, 'leases.sqlite'),
      {
        verifyGateway: async () => {
          if (options.failDriverConfig) throw new Error('driver config unavailable');
        },
        verifyMount,
        verifyDeleted,
      },
      async () => [{ Name: request.volumeName, Driver: 'local', Options: {}, Labels: labels }],
    );
    const ensure = vi.fn(async (runtimeId: string) => {
      if (options.failCreate) throw new Error('create response lost');
      return {
        sandboxName: sandboxNameForConversation(runtimeId, 13),
        sandboxId: 'physical-1',
        workdir: '/sandbox/workspaces/mgmt',
      };
    });
    const configurations: BoundOpenShellRuntimeConfig[] = [];
    const registry = seatSandboxRegistry();
    let phase: 'Ready' | 'Stopped' | 'Absent' = 'Ready';
    const stop = vi.fn(async () => {
      phase = 'Stopped';
    });
    const remove = vi.fn(async () => {
      phase = 'Absent';
    });
    const owner = () =>
      new SymposiumPerSeatSandboxOwner({
        sessionId: 'symposium',
        facts: fixture().facts,
        profiles,
        hostGrants,
        seatSandboxRegistry: registry,
        resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace: 'default' }),
        runtimeConfig: {
          cli: 'openshell',
          cliContract: 'v0.1',
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
        perSeatSandboxVerified: true,
        artifactLeaseHost: host,
        artifactRequest: () => request,
        managerFactory: (config) => {
          configurations.push(config);
          return {
            ensure,
            inspect: async (_runtimeId: string, physicalId: string) =>
              phase === 'Absent' ? undefined : { id: physicalId, phase },
            inspectReserved: async (runtimeId: string) =>
              phase === 'Absent'
                ? undefined
                : {
                    id: 'physical-1',
                    name: sandboxNameForConversation(runtimeId, 13),
                    phase,
                  },
            stop,
            delete: remove,
          };
        },
      });
    return {
      root,
      request,
      host,
      owner,
      ensure,
      verifyMount,
      verifyDeleted,
      stop,
      remove,
      registry,
      configurations,
      setPhase: (next: typeof phase) => {
        phase = next;
      },
    };
  }

  for (const access of ['writer', 'reviewer'] as const) {
    it(`attests and retains the ${access} mount on an exact retry`, async () => {
      const state = setup(access);
      try {
        await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
        await state.owner().ensure('symposium', 'reviewer', new AbortController().signal);
        expect(state.configurations).toHaveLength(2);
        expect(state.configurations[0].artifactDriverConfig).toEqual({
          podman: {
            mounts: [
              {
                type: 'volume',
                source: state.request.volumeName,
                target: '/sandbox/symposium-artifacts',
                read_only: access === 'reviewer',
              },
            ],
          },
        });
        expect(state.verifyMount).toHaveBeenCalledWith(
          expect.any(String),
          'physical-1',
          state.configurations[0].artifactDriverConfig,
        );
      } finally {
        state.host.close();
        rmSync(state.root, { recursive: true, force: true });
      }
    });
  }

  it('retains a closed lease when creation loses its response or mount proof fails', async () => {
    for (const options of [{ failCreate: true }, { failMount: true }]) {
      const state = setup('writer', options);
      try {
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).rejects.toThrow(options.failCreate ? 'create response lost' : 'physical mount mismatch');
        await expect(
          state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
        ).rejects.toThrow('reservation changed');
        expect(state.ensure).toHaveBeenCalledTimes(1);
      } finally {
        state.host.close();
        rmSync(state.root, { recursive: true, force: true });
      }
    }
  });

  it('releases the exact unstarted writer after crash recovery proves the seat absent', async () => {
    const state = setup('writer', { failDriverConfig: true });
    try {
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow('driver config unavailable');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)).toMatchObject({
        state: 'reserved',
        creationStarted: false,
      });
      state.setPhase('Absent');
      await state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('quarantines a started writer when the seat registry still says unstarted', async () => {
    const state = setup('writer', { failDriverConfig: true });
    try {
      await expect(
        state.owner().ensure('symposium', 'reviewer', new AbortController().signal),
      ).rejects.toThrow('driver config unavailable');
      const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
      const lease = await state.host.reserve(state.request);
      state.host.markCreationStarted(
        lease.token,
        lease.revision,
        sandboxNameForConversation(record.runtimeId, 13),
      );
      state.setPhase('Absent');
      await expect(
        state.owner().stop('symposium', 'reviewer', 2, new AbortController().signal),
      ).rejects.toThrow('creation may be in flight');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'reserved',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).rejects.toThrow('already has a writer');
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('deletes the exact stopped sandbox before releasing the writer for rotation', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.stop).toHaveBeenCalledWith(record.runtimeId, 'physical-1', expect.anything());
      expect(state.remove).toHaveBeenCalledWith(record.runtimeId, 'physical-1', expect.anything());
      expect(state.verifyDeleted).toHaveBeenCalledWith(record.sandboxName, 'physical-1');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('uses the durable physical identity after discovering a reserved sandbox', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      const record = state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)!;
      const sandboxName = record.sandboxName;
      // Simulate a crash after the artifact lease was bound but before the
      // seat registry committed its physical identity.
      record.sandboxName = null;
      record.physicalId = null;
      record.state = 'reserved';
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.remove).toHaveBeenCalledWith(record.runtimeId, 'physical-1', expect.anything());
      expect(state.verifyDeleted).toHaveBeenCalledWith(sandboxName, 'physical-1');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'stopped',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retains the writer and retries absence proof when deletion is uncertain', async () => {
    const state = setup('writer');
    try {
      const owner = state.owner();
      await owner.ensure('symposium', 'reviewer', new AbortController().signal);
      state.remove.mockRejectedValueOnce(new Error('gateway deletion uncertain'));
      await expect(
        owner.stop('symposium', 'reviewer', 2, new AbortController().signal),
      ).rejects.toThrow('gateway deletion uncertain');
      expect(state.registry.getSymposiumSeatSandbox('symposium', 'reviewer', 2)?.state).toBe(
        'ready',
      );
      await expect(
        acquireSymposiumArtifactLease(state.host, { ...state.request, seatId: 'next' }),
      ).rejects.toThrow('already has a writer');
      await owner.stop('symposium', 'reviewer', 2, new AbortController().signal);
      expect(state.stop).toHaveBeenCalledOnce();
      expect(state.remove).toHaveBeenCalledTimes(2);
    } finally {
      state.host.close();
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
