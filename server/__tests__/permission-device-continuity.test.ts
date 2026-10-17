import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPermissionHandler,
  ConnectionRegistry,
  resolvePending,
  type SessionTransport,
} from '@mitzo/harness';

it('wires all provider approvals to both live device subscriptions through the chat registry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-permission-devices-'));
  vi.stubEnv('REPO_PATH', directory);
  const mcpConfig = join(directory, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));
  vi.stubEnv('MCP_CONFIG_PATH', mcpConfig);
  const chat = await import('../chat.js');
  const connections = new ConnectionRegistry();
  const transport = (): SessionTransport & { sent: Record<string, unknown>[] } => {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      send: (event) => {
        sent.push(event);
      },
      isOpen: () => true,
    };
  };
  const web = transport();
  const phone = transport();
  const abort = new AbortController();
  const sessionId = 'shared-approval-chat';
  const clientId = 'web:shared-approval-chat';
  try {
    chat.setConnectionRegistry(connections);
    connections.register('web', web);
    connections.register('phone', phone);
    connections.watch('web', sessionId);
    connections.watch('phone', sessionId);
    chat.eventStore.upsertSession({ sessionId, mode: 'agent' });
    chat.eventStore.setSessionState(sessionId, 'ACTIVE', { force: true });
    chat.registry.register(clientId, {
      sessionId,
      ownerConnectionId: 'web',
      transport: web,
      abortController: abort,
      mode: 'agent',
      sessionAllowList: new Set(),
    });
    const handler = buildPermissionHandler(clientId, chat.registry);
    const pending = handler(
      'mcp__custom__operation',
      {},
      {
        signal: abort.signal,
        toolUseID: 'before-handoff',
      },
    );
    await Promise.resolve();
    expect(phone.sent).toEqual(web.sent);
    expect(phone.sent).toHaveLength(1);
    expect(chat.reattachChat(clientId, phone)).toBe(true);
    chat.registry.get(clientId)!.ownerConnectionId = 'phone';
    const permId = phone.sent[0].permId as string;
    expect(resolvePending(permId, 'once', undefined, sessionId)).toBe(true);
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect(web.sent.at(-1)).toEqual({ type: 'permission_resolved', sessionId, permId });
    expect(phone.sent).toEqual(web.sent);
    expect(web.sent).toHaveLength(2);

    const next = handler(
      'mcp__custom__operation',
      { next: true },
      {
        signal: abort.signal,
        toolUseID: 'after-handoff',
      },
    );
    await Promise.resolve();
    expect(web.sent.at(-1)?.type).toBe('permission_request');
    expect(phone.sent).toEqual(web.sent);
    resolvePending(web.sent.at(-1)!.permId as string, 'deny', undefined, sessionId);
    expect(await next).toMatchObject({ behavior: 'deny' });
    expect(phone.sent).toEqual(web.sent);
    expect(web.sent).toHaveLength(4);
  } finally {
    abort.abort();
    chat.registry.dispose();
    connections.dispose();
    chat.eventStore.close();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
