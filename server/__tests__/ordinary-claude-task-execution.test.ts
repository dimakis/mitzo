import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, resolvePending, checkSkillTool } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import { NotificationCenter } from '../notification-center.js';
import { NotificationStore } from '../notification-store.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import * as tasks from '../task-execution-runtime.js';
import type { SandboxedCommandOptions } from '../sandboxed-command.js';
import { createSdkCallbackState } from '../ordinary-local-vertex-sdk-query.js';

const execution = vi.hoisted(() => ({ calls: [] as SandboxedCommandOptions[], wait: false }));
// Keep SDK MCP, task admission, native permission handling and final spawn fences
// real. Only the sandbox process effect and push delivery are synthetic.
vi.mock('../sandboxed-command.js', async (original) => ({
  ...(await original<object>()),
  executeSandboxedCommand: async (options: SandboxedCommandOptions) => {
    await options.beforeSpawnAsync?.();
    options.beforeSpawn?.();
    execution.calls.push(options);
    if (execution.wait)
      await new Promise<void>((_resolve, reject) => {
        options.signal.throwIfAborted();
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    return { content: 'passed', isError: false };
  },
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  execution.calls.length = 0;
  execution.wait = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  provider: 'anthropic-claude' | 'anthropic-vertex',
  selected = true,
  frozenTools?: string[],
  managedName = 'TaskExecution',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-task-parity-')));
  cleanups.push(() => rmSync(root, { recursive: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const store = new TaskExecutionStore(join(root, 'tasks.db'));
  cleanups.push(() => store.close());
  const storeRead = vi.spyOn(tasks, 'getTaskExecutionStore').mockReturnValue(store);
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  const sent: Array<{ type: string; permId?: string }> = [];
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const sessionId = 'ordinary-claude-task';
  registry.register('owner', {
    sessionId,
    mode: 'agent',
    cwd: workspace,
    sessionAllowList: new Set(),
    abortController: controller,
    transport: { send: (event) => sent.push(event), isOpen: () => true },
    ownedLocalAuthSessionId: 'operator',
    accountBinding: {
      accountId: provider,
      accountLabel: 'Offline account',
      provider,
      model: 'offline-model',
      profileRevision: 'offline-revision',
    },
  });
  cleanups.push(
    bindAgentLibraryTransport('owner', { id: 'operator', expiresAt: Date.now() + 600000 }),
  );
  const session = registry.get('owner')!;
  const profile = { tools: selected ? [{ id: `mitzo:${managedName}`, version: 1 }] : [] } as never;
  assertAgentToolRoute(profile, 'claude-sdk');
  bindAgentToolSelection(session, profile, 'claude-sdk');
  const authority = {
    current: true,
    gate: undefined as (() => Promise<void>) | undefined,
    effectGate: undefined as (() => Promise<void>) | undefined,
  };
  const agentEffects = vi.fn();
  const assertCurrent = () => {
    if (!authority.current) throw Error('Original Claude authority revoked');
  };
  const state = createSdkCallbackState();
  if (frozenTools !== undefined) {
    const ceiling = new Set(frozenTools);
    state.bindCommandToolAuthority({
      commandId: 'original-command',
      checkTool: (name) => checkSkillTool(ceiling, name),
    });
  }
  const server = createCredentialSdkServer(() => sessionId, session, registry, {
    profilesOnly: true,
    checkTool: (name) => state.checkTool(name),
    runCallback: state.runCallback,
    ...(managedName === 'AgentCommunication'
      ? {
          agentCommunication: (assertToolCurrent?: () => void) => ({
            execute: async () => {
              await authority.effectGate?.();
              assertToolCurrent?.();
              agentEffects();
              return { content: JSON.stringify({ chats: [] }), isError: false };
            },
          }),
        }
      : {}),
    assertCurrent: async () => {
      await authority.gate?.();
      assertCurrent();
    },
    assertCurrentSync: assertCurrent,
  });
  const client = new Client({ name: 'offline-claude-task', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const notifications = new NotificationStore(':memory:');
  cleanups.push(() => notifications.close());
  const push = vi.fn(async () => ({
    status: 'accepted' as const,
    acceptedDevices: ['offline-device'],
  }));
  const center = new NotificationCenter(notifications, {
    push,
    changed() {},
    configured: () => true,
    devices: () => 1,
    sessionTitle: () => 'Offline task',
  });
  cleanups.push(() => center.close());
  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: managedName, arguments: args });
  const decode = (result: Awaited<ReturnType<typeof call>>) => {
    const content = result.content as Array<{ type: string; text?: string }>;
    return JSON.parse(content.map((block) => block.text ?? '').join(''));
  };
  return {
    client,
    call,
    decode,
    sent,
    session,
    sessionId,
    registry,
    authority,
    center,
    push,
    store,
    controller,
    state,
    storeRead,
    agentEffects,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

it('passes the original command fence into a special managed peer handler before its effect', async () => {
  const f = await fixture(
    'anthropic-claude',
    true,
    ['mcp__mitzo-connections__AgentCommunication'],
    'AgentCommunication',
  );
  expect((await f.call({ operation: 'list', offset: 0 })).isError).not.toBe(true);
  expect(f.agentEffects).toHaveBeenCalledOnce();
  f.authority.effectGate = async () => {
    f.state.retired = true;
  };
  expect((await f.call({ operation: 'list', offset: 0 })).isError).toBe(true);
  expect(f.agentEffects).toHaveBeenCalledOnce();
});

it.each([
  { ceiling: [] },
  { ceiling: ['TaskExecution'] },
  { ceiling: ['mcp__mitzo-connections__ListConnections'] },
])(
  'refuses a named TaskExecution handler outside the original wire-name ceiling ($ceiling)',
  async ({ ceiling }) => {
    const f = await fixture('anthropic-claude', true, ceiling);
    expect((await f.call({ operation: 'status' })).isError).toBe(true);
    expect(f.storeRead).not.toHaveBeenCalled();
    expect(f.sent).toHaveLength(0);
  },
);

it('admits the exact named handler and rechecks original command retirement after awaited authority', async () => {
  const f = await fixture('anthropic-vertex', true, ['mcp__mitzo-connections__TaskExecution']);
  expect((await f.call({ operation: 'status' })).isError).not.toBe(true);
  const reads = f.storeRead.mock.calls.length;
  f.authority.gate = async () => {
    f.state.retired = true;
  };
  expect((await f.call({ operation: 'status' })).isError).toBe(true);
  expect(f.storeRead).toHaveBeenCalledTimes(reads);
  expect(f.sent).toHaveLength(0);
});

async function authorize(f: Fixture, decision: 'once' | 'deny' = 'once') {
  const count = f.sent.filter((event) => event.type === 'permission_request').length;
  const pending = f.call({
    operation: 'authorize',
    requestId: randomUUID(),
    title: 'Offline repair',
    network: 'none',
    repositories: [],
    durationMinutes: 5,
  });
  await vi.waitFor(() =>
    expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(count + 1),
  );
  await f.center.flush();
  const request = f.sent.filter((event) => event.type === 'permission_request').at(-1)!;
  resolvePending(request.permId!, decision, undefined, f.sessionId);
  return pending;
}

it.each(['anthropic-claude', 'anthropic-vertex'] as const)(
  'reuses one %s SDK task decision and alert for command variants, then fences revocation',
  async (provider) => {
    const f = await fixture(provider);
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual(['TaskExecution']);
    expect(
      credentialSdkPermission(
        'mcp__mitzo-connections__TaskExecution',
        { operation: 'status' },
        'owner',
        f.registry,
        f.session,
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(f.decode(await f.call({ operation: 'status' })).grants).toEqual([]);
    expect(f.sent).toHaveLength(0);
    const result = await authorize(f);
    expect(result.isError).not.toBe(true);
    const { grant, executionRoute } = f.decode(result);
    expect(executionRoute.tool).toBe('mcp__mitzo-connections__TaskExecution');
    for (const command of ['npm test', 'npm run build']) {
      const ran = await f.call({
        operation: 'run',
        grantId: grant.id,
        requestId: randomUUID(),
        command,
      });
      expect(ran.isError).not.toBe(true);
    }
    await f.center.flush();
    expect(execution.calls).toHaveLength(2);
    expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1);
    expect(f.push).toHaveBeenCalledOnce();
    expect((await f.call({ operation: 'revoke', grantId: grant.id })).isError).not.toBe(true);
    const refused = await f.call({
      operation: 'run',
      grantId: grant.id,
      requestId: randomUUID(),
      command: 'npm test',
    });
    expect(refused.isError).toBe(true);
    expect(execution.calls).toHaveLength(2);
    expect(f.push).toHaveBeenCalledOnce();
  },
);

it('keeps omitted tools absent and refuses a retired SDK owner before dispatch', async () => {
  const omitted = await fixture('anthropic-claude', false);
  await expect(omitted.client.listTools()).rejects.toThrow(/Method not found/);
  const f = await fixture('anthropic-claude');
  f.authority.current = false;
  expect((await f.call({ operation: 'status' })).isError).toBe(true);
  expect(execution.calls).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});

it('retains a denied decision without a task grant or command effect', async () => {
  const f = await fixture('anthropic-claude');
  expect((await authorize(f, 'deny')).isError).toBe(true);
  expect(f.decode(await f.call({ operation: 'status' })).grants).toEqual([]);
  expect(execution.calls).toHaveLength(0);
  expect(f.push).toHaveBeenCalledOnce();
});

it.each(['ask', 'account', 'owner'] as const)(
  'fences a retained SDK grant after %s changes without another approval',
  async (change) => {
    const f = await fixture('anthropic-vertex');
    const { grant } = f.decode(await authorize(f));
    if (change === 'ask') f.session.mode = 'ask';
    else if (change === 'account')
      f.session.accountBinding = { ...f.session.accountBinding!, accountId: 'different-account' };
    else f.authority.current = false;
    expect(
      (
        await f.call({
          operation: 'run',
          grantId: grant.id,
          requestId: randomUUID(),
          command: 'npm test',
        })
      ).isError,
    ).toBe(true);
    expect(execution.calls).toHaveLength(0);
    expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1);
  },
);

it.each(['expiry', 'revocation', 'owner-loss'] as const)(
  'cancels a running SDK command on %s and preserves uncertainty without replay',
  async (reason) => {
    const f = await fixture('anthropic-claude');
    const { grant } = f.decode(await authorize(f));
    vi.useFakeTimers();
    // Start near the retained grant's expiry, before either the MCP request or
    // command deadline. Advancing five minutes would test client timeout first.
    if (reason === 'expiry') vi.setSystemTime(grant.expiresAt - 1_000);
    execution.wait = true;
    const input = {
      operation: 'run',
      grantId: grant.id,
      requestId: randomUUID(),
      command: 'npm test',
    };
    const pending = f.call(input);
    await vi.waitFor(() => expect(execution.calls).toHaveLength(1));
    if (reason === 'expiry') await vi.advanceTimersByTimeAsync(grant.expiresAt - Date.now() + 1);
    else if (reason === 'revocation')
      expect((await f.call({ operation: 'revoke', grantId: grant.id })).isError).not.toBe(true);
    else {
      f.authority.current = false;
      f.controller.abort(Error('Original SDK owner lost'));
    }
    expect((await pending).isError).toBe(true);
    expect(execution.calls[0].signal.aborted).toBe(true);
    expect(f.store.runStatus(grant.id, f.sessionId, input.requestId).state).toBe('uncertain');
    expect((await f.call(input)).isError).toBe(true);
    expect(execution.calls).toHaveLength(1);
    expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1);
    expect(f.push).toHaveBeenCalledOnce();
  },
);
