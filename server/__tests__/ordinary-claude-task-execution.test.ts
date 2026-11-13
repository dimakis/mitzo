import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import { NotificationCenter } from '../notification-center.js';
import { NotificationStore } from '../notification-store.js';
import { TaskExecutionStore } from '../task-execution-store.js';
import * as tasks from '../task-execution-runtime.js';

const execution = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../native-tool-executor.js', async (original) => ({
  ...(await original<object>()),
  createNativeToolExecutor:
    (_client: string, _registry: unknown, options: { assertRuntimeCurrent(): void }) =>
    async (block: unknown) => {
      options.assertRuntimeCurrent();
      execution.calls.push(block);
      return { type: 'tool_result', tool_use_id: 'offline', content: 'passed', is_error: false };
    },
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  execution.calls.length = 0;
  vi.restoreAllMocks();
});

async function fixture(provider: 'anthropic-claude' | 'anthropic-vertex', selected = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-task-parity-')));
  cleanups.push(() => rmSync(root, { recursive: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const store = new TaskExecutionStore(join(root, 'tasks.db'));
  cleanups.push(() => store.close());
  vi.spyOn(tasks, 'getTaskExecutionStore').mockReturnValue(store);
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
  const profile = { tools: selected ? [{ id: 'mitzo:TaskExecution', version: 1 }] : [] } as never;
  assertAgentToolRoute(profile, 'claude-sdk');
  bindAgentToolSelection(session, profile, 'claude-sdk');
  const authority = { current: true };
  const assertCurrent = () => {
    if (!authority.current) throw Error('Original Claude authority revoked');
  };
  const server = createCredentialSdkServer(() => sessionId, session, registry, {
    profilesOnly: true,
    assertCurrent: async () => assertCurrent(),
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
    client.callTool({ name: 'TaskExecution', arguments: args });
  const decode = (result: Awaited<ReturnType<typeof call>>) => {
    const content = result.content as Array<{ type: string; text?: string }>;
    return JSON.parse(content.map((block) => block.text ?? '').join(''));
  };
  return { client, call, decode, sent, session, sessionId, registry, authority, center, push };
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
    const approval = f.call({
      operation: 'authorize',
      requestId: randomUUID(),
      title: 'Offline repair',
      network: 'none',
      repositories: [],
      durationMinutes: 5,
    });
    await vi.waitFor(() =>
      expect(f.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1),
    );
    await f.center.flush();
    expect(f.push).toHaveBeenCalledOnce();
    const request = f.sent.find((event) => event.type === 'permission_request')!;
    resolvePending(request.permId!, 'once', undefined, f.sessionId);
    const result = await approval;
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
