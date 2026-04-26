import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { resolvePending } from '../src/permissions.js';
import { setSkillPolicy } from '../src/skill-policy.js';
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
});
