import { expect, it, vi } from 'vitest';
vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  preflightChatCommand: vi.fn(),
  preflightStartupProviderCommand: vi.fn(),
  nativeStartupSessionId: vi.fn(),
  stopChat: vi.fn(),
  closeSessionByUser: vi.fn(),
  isActive: vi.fn(),
  reattachChat: vi.fn(),
  BASE_REPO: '/unused',
  discoverSession: vi.fn(),
}));
vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn(),
  isAllowedPath: vi.fn(),
  NATIVE_COMMAND_NAMES: new Set(),
}));
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { NativeCommandRegistry } from '../native-commands.js';
import { handleSwitchSession, handlePermissionResponseV2 } from '../ws-handler-v2.js';
import { publicationControllerApproval } from '../symposium-publication-approval.js';
import { startChat } from '../chat.js';
const request = {
  capabilityId: 'github.publish-pr',
  capabilityVersion: 1,
  connectionId: 'write',
  operationId: 'operation',
  input: { title: 'Reviewed' },
  forcePrompt: true as const,
};
it('uses native switch/watch, concurrent normal approvals and real WS responses without SDK dispatch', async () => {
  const connRegistry = new ConnectionRegistry(),
    sessionRegistry = new SessionRegistry(),
    eventStore = new EventStore(':memory:');
  eventStore.upsertSession({
    sessionId: 'session',
    mode: 'agent',
    cwd: '/unused',
  });
  eventStore.setSymposiumConfig('session', {
    version: 1,
    revision: 1,
    state: 'draft',
    seats: ['primary', 'reviewer'].map((role) => ({
      id: role,
      name: role,
      role,
      model: 'mock',
      systemPrompt: '',
      color: '#000000',
    })),
    turnRules: { mode: 'directed', maxTurns: 2 },
    interceptMode: 'manual',
  });
  eventStore.setSessionState('session', 'ENDED', { reason: 'completed' });
  const messages: Record<string, unknown>[] = [];
  connRegistry.register('browser', { send: (value) => messages.push(value), isOpen: () => true });
  const ctx = {
    connRegistry,
    sessionRegistry,
    eventStore,
    nativeCommands: new NativeCommandRegistry(),
  };
  await handleSwitchSession('browser', { type: 'switch_session', sessionId: 'session' }, ctx);
  expect(sessionRegistry.findBySessionId('session', true)).toBeNull();
  const otherMessages: Record<string, unknown>[] = [];
  connRegistry.register('other-browser', {
    send: (value) => otherMessages.push(value),
    isOpen: () => true,
  });
  await handleSwitchSession('other-browser', { type: 'switch_session', sessionId: 'session' }, ctx);
  const owned = (connection: string, actor: string) =>
    ['browser', 'other-browser'].includes(connection) && actor === 'login';
  expect(
    publicationControllerApproval(
      sessionRegistry,
      owned,
      'session',
      'login',
      undefined,
      connRegistry,
    ),
  ).toBeUndefined();
  expect(
    publicationControllerApproval(
      sessionRegistry,
      owned,
      'session',
      'login',
      'missing',
      connRegistry,
    ),
  ).toBeUndefined();
  const approval = publicationControllerApproval(
    sessionRegistry,
    owned,
    'session',
    'login',
    'browser',
    connRegistry,
  );
  expect(approval).toBeDefined();
  const first = approval!(request, new AbortController().signal);
  const second = approval!({ ...request, operationId: 'second' }, new AbortController().signal);
  const owner = sessionRegistry.findBySessionId('session', true)!;
  expect(sessionRegistry.isActive(owner.clientId)).toBe(false);
  expect(sessionRegistry.isAttached(owner.clientId)).toBe(false);
  expect(sessionRegistry.getActiveSessions()).toEqual([]);
  expect([...sessionRegistry.entries()]).toEqual([]);
  expect(sessionRegistry.findBySessionId('session')).toBeNull();
  await handleSwitchSession('browser', { type: 'switch_session', sessionId: 'session' }, ctx);
  const states = messages.filter((value) => value.type === 'session_state_changed');
  expect(states).toHaveLength(2);
  expect(states.every((value) => value.internalState === 'ENDED')).toBe(true);
  await vi.waitFor(() =>
    expect(messages.filter((value) => value.type === 'permission_request')).toHaveLength(2),
  );
  const permissions = messages.filter((value) => value.type === 'permission_request');
  expect(permissions).toHaveLength(2);
  expect(otherMessages.filter((value) => value.type === 'permission_request')).toEqual([]);
  expect(
    handlePermissionResponseV2(
      'other-browser',
      {
        type: 'permission_response',
        sessionId: 'session',
        permId: String(permissions[0].permId),
        decision: 'once',
      },
      ctx,
    ),
  ).toBe(false);
  expect(
    handlePermissionResponseV2(
      'browser',
      {
        type: 'permission_response',
        sessionId: 'session',
        permId: String(permissions[0].permId),
        decision: 'once',
      },
      ctx,
    ),
  ).toBe(true);
  expect(await first).toBe(true);
  expect(sessionRegistry.findBySessionId('session', true)).not.toBeNull();
  handlePermissionResponseV2(
    'browser',
    {
      type: 'permission_response',
      sessionId: 'session',
      permId: String(permissions[1].permId),
      decision: 'once',
    },
    ctx,
  );
  expect(await second).toBe(true);
  expect(sessionRegistry.findBySessionId('session', true)).toBeNull();
  const pending = approval!(request, new AbortController().signal);
  await vi.waitFor(() =>
    expect(messages.filter((value) => value.type === 'permission_request')).toHaveLength(3),
  );
  connRegistry.unwatch('browser', 'session');
  await expect(pending).rejects.toThrow();
  expect(sessionRegistry.findBySessionId('session', true)).toBeNull();
  await handleSwitchSession('browser', { type: 'switch_session', sessionId: 'session' }, ctx);
  const again = publicationControllerApproval(
    sessionRegistry,
    (connection, actor) => connection === 'browser' && actor === 'login',
    'session',
    'login',
    undefined,
    connRegistry,
  )!;
  const expired = new AbortController();
  const authPending = again(request, expired.signal);
  await vi.waitFor(() =>
    expect(messages.filter((value) => value.type === 'permission_request')).toHaveLength(4),
  );
  expired.abort();
  await expect(authPending).rejects.toThrow();
  expect(sessionRegistry.findBySessionId('session', true)).toBeNull();
  const reconnectPending = again(request, new AbortController().signal);
  await vi.waitFor(() =>
    expect(messages.filter((value) => value.type === 'permission_request')).toHaveLength(5),
  );
  connRegistry.remove('browser');
  connRegistry.register('replacement', {
    send: (value) => messages.push(value),
    isOpen: () => true,
  });
  await handleSwitchSession('replacement', { type: 'switch_session', sessionId: 'session' }, ctx);
  await expect(reconnectPending).rejects.toThrow();
  expect(sessionRegistry.findBySessionId('session', true)).toBeNull();
  const replacementApproval = publicationControllerApproval(
    sessionRegistry,
    () => true,
    'session',
    'login',
    'replacement',
    connRegistry,
  )!;
  const displaced = replacementApproval(request, new AbortController().signal);
  await vi.waitFor(() =>
    expect(messages.filter((value) => value.type === 'permission_request')).toHaveLength(6),
  );
  const actual = new AbortController();
  sessionRegistry.register('real-owner', {
    sessionId: 'session',
    ownerConnectionId: 'replacement',
    transport: connRegistry.get('replacement')!.transport,
    abortController: actual,
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const lastPermission = messages.filter((value) => value.type === 'permission_request').at(-1)!;
  handlePermissionResponseV2(
    'replacement',
    {
      type: 'permission_response',
      sessionId: 'session',
      permId: String(lastPermission.permId),
      decision: 'once',
    },
    ctx,
  );
  await expect(displaced).rejects.toThrow('controller');
  expect(sessionRegistry.findBySessionId('session', true)?.clientId).toBe('real-owner');
  expect(actual.signal.aborted).toBe(false);
  expect(startChat).not.toHaveBeenCalled();
  sessionRegistry.dispose();
  connRegistry.dispose();
  eventStore.close();
});
