import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { resolvePending } from '../src/permissions.js';
import { setSkillPolicy } from '../src/skill-policy.js';
import { applyTierOverrides } from '../src/tool-tiers.js';
import type { SessionTransport } from '../src/session-transport.js';

function fakeTransport(): SessionTransport & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send: (data: Record<string, unknown>) => sent.push(data),
    isOpen: () => true,
  };
}

describe('buildPermissionHandler', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
    applyTierOverrides({});
  });

  it('auto-allows safe tools in agent mode', async () => {
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const handler = buildPermissionHandler('client-1', registry);
    const result = await handler(
      'Read',
      { file_path: '/foo' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );

    expect(result.behavior).toBe('allow');
  });

  it('denies when session not found', async () => {
    const handler = buildPermissionHandler('nonexistent', registry);
    const result = await handler(
      'Read',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Session not found');
  });

  it('denies tools blocked by skill policy', async () => {
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    setSkillPolicy(registry, 'client-1', ['Read', 'Grep']);

    const handler = buildPermissionHandler('client-1', registry);
    const result = await handler(
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Tool not allowed by active skill policy');
  });

  it('uses session allow list for permanent allows', async () => {
    const transport = fakeTransport();
    const allowList = new Set(['mcp__jira__']);
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: allowList,
    });

    const handler = buildPermissionHandler('client-1', registry);
    const result = await handler(
      'mcp__jira__search',
      { query: 'test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );

    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_permanent');
  });

  it('sends permission_request for unknown tools and resolves on response', async () => {
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const handler = buildPermissionHandler('client-1', registry);
    const promise = handler(
      'mcp__custom__tool',
      { arg: 'val' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );

    // Flush microtasks to allow async checkWorktreePolicy to complete
    await Promise.resolve();

    // Should have sent a permission_request
    expect(transport.sent.length).toBe(1);
    expect(transport.sent[0].type).toBe('permission_request');

    const permId = transport.sent[0].permId as string;
    resolvePending(permId, 'once');

    const result = await promise;
    expect(result.behavior).toBe('allow');
    expect(result.decisionClassification).toBe('user_temporary');
  });

  it('denies when aborted', async () => {
    const transport = fakeTransport();
    const abort = new AbortController();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });

    const handler = buildPermissionHandler('client-1', registry);

    // Abort before calling
    abort.abort();
    const result = await handler(
      'mcp__custom__tool',
      {},
      {
        signal: abort.signal,
        toolUseID: 'tool-1',
      },
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Aborted');
  });
  it.each([
    'Write',
    'Bash',
    'mcp__custom__tool',
    'TodoWrite',
    'Task',
    'mcp__task-board__TaskSet',
    'mcp__task-board__TaskComplete',
    'mcp__task-board__TaskBlock',
  ])('hard denies %s in Ask even if allowlisted', async (toolName) => {
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'ask',
      sessionAllowList: new Set([toolName]),
    });
    const onDemandCreate = vi.fn().mockResolvedValue(null);
    registry.get('client-1')!.worktreePaths.set('repo', { path: '/isolated', wtId: 'wt' });
    const result = await buildPermissionHandler('client-1', registry, { onDemandCreate })(
      toolName,
      { file_path: '/outside/file', command: 'echo hi' },
      { signal: new AbortController().signal, toolUseID: 'tool-1' },
    );
    expect(result).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Ask mode'),
    });
    expect(onDemandCreate).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it.each([
    'Write',
    'Bash',
    'mcp__custom__tool',
    'TodoWrite',
    'Task',
    'mcp__task-board__TaskSet',
    'mcp__task-board__TaskComplete',
    'mcp__task-board__TaskBlock',
  ])('hard denies %s in Ask despite safe tier override and cached grant', async (toolName) => {
    applyTierOverrides({ [toolName]: 'safe' });
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'ask',
      sessionAllowList: new Set([toolName]),
    });
    const onDemandCreate = vi.fn().mockResolvedValue(null);
    registry.get('client-1')!.worktreePaths.set('repo', { path: '/isolated', wtId: 'wt' });
    const result = await buildPermissionHandler('client-1', registry, { onDemandCreate })(
      toolName,
      { file_path: '/outside/file', command: 'echo hi' },
      { signal: new AbortController().signal, toolUseID: 'tool-1' },
    );
    expect(result).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Ask mode'),
    });
    expect(onDemandCreate).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it('prompts for shell in Agent and auto-allows it in Auto', async () => {
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const handler = buildPermissionHandler('client-1', registry);
    const promise = handler(
      'Bash',
      { command: 'echo hi' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );
    await Promise.resolve();
    expect(transport.sent[0]).toMatchObject({ type: 'permission_request', tier: 'elevated' });
    resolvePending(transport.sent[0].permId as string, 'once');
    expect((await promise).behavior).toBe('allow');
    registry.setMode('client-1', 'auto');
    expect(
      (
        await handler(
          'Bash',
          { command: 'echo hi' },
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-2',
          },
        )
      ).behavior,
    ).toBe('allow');
    expect(transport.sent.filter((event) => event.type === 'permission_request')).toHaveLength(1);
  });

  it('rejects pending approvals after a downgrade to Ask without saving permission', async () => {
    const transport = fakeTransport();
    const allowList = new Set<string>();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: allowList,
    });
    const promise = buildPermissionHandler('client-1', registry)(
      'mcp__custom__tool',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );
    await Promise.resolve();
    registry.setMode('client-1', 'ask');
    resolvePending(transport.sent[0].permId as string, 'always');
    expect(await promise).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Ask mode'),
    });
    expect(allowList.size).toBe(0);
  });

  it('rejects pending approvals while a downgrade to Ask is awaiting the provider without saving permission', async () => {
    const transport = fakeTransport();
    const allowList = new Set<string>();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: allowList,
    });
    const promise = buildPermissionHandler('client-1', registry)(
      'mcp__custom__tool',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );
    await Promise.resolve();
    registry.get('client-1')!.pendingPermissionModes = new Map([[Symbol(), 'ask']]);
    resolvePending(transport.sent[0].permId as string, 'always');
    expect(await promise).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Ask mode'),
    });
    expect(allowList.size).toBe(0);
  });

  it('rejects pending approvals after a safe tier override while Ask is pending without saving permission', async () => {
    const transport = fakeTransport();
    const allowList = new Set<string>();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: allowList,
    });
    const promise = buildPermissionHandler('client-1', registry)(
      'mcp__custom__tool',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      },
    );
    await Promise.resolve();
    registry.get('client-1')!.pendingPermissionModes = new Map([[Symbol(), 'ask']]);
    applyTierOverrides({ mcp__custom__tool: 'safe' });
    resolvePending(transport.sent[0].permId as string, 'always');
    expect(await promise).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Ask mode'),
    });
    expect(allowList.size).toBe(0);
  });

  it('still allows user questions in Ask', async () => {
    const transport = fakeTransport();
    registry.register('client-1', {
      transport,
      abortController: new AbortController(),
      mode: 'ask',
      sessionAllowList: new Set(),
    });
    const promise = buildPermissionHandler('client-1', registry)(
      'AskUserQuestion',
      {
        questions: [{ question: 'Which file?' }],
      },
      { signal: new AbortController().signal, toolUseID: 'tool-1' },
    );
    await Promise.resolve();
    expect(transport.sent[0]).toMatchObject({
      type: 'permission_request',
      questions: expect.any(Array),
    });
    resolvePending(transport.sent[0].permId as string, 'once', { 'Which file?': ['README.md'] });
    expect((await promise).behavior).toBe('allow');
  });
});
