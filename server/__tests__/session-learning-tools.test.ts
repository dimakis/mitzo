import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionRegistry, type ManagedSession } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { sessionLocalServiceTools } from '../session-local-service-tools.js';
import { installSessionLearningRuntime } from '../session-learning-tools.js';
import { credentialSdkPermission } from '../credential-sdk-tools.js';
import { sessionLearningGuidance } from '@mitzo/protocol';

let events: EventStore;
let registry: SessionRegistry;
let session: ManagedSession;
let release: () => void;
let unbind: () => void;
let input: Record<string, unknown>;
beforeEach(() => {
  events = new EventStore(':memory:');
  events.upsertSession({ sessionId: 'chat', cwd: '/offline' });
  const eventSeq = events.append('chat', 'user_message', {
    messageId: 'user',
    text: 'Remember the correction',
  });
  registry = new SessionRegistry();
  registry.register('client', {
    sessionId: 'chat',
    cwd: '/offline',
    mode: 'auto',
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    ownerConnectionId: 'operator',
    transport: { send: () => {}, isOpen: () => true },
  });
  session = registry.get('client')!;
  unbind = bindAgentLibraryTransport('operator', { id: 'login', expiresAt: Date.now() + 60000 });
  release = installSessionLearningRuntime(events);
  input = {
    action: 'capture',
    candidate: {
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sources: [{ messageId: 'user', eventSeq }],
      text: 'Use the corrected decision.',
      kind: 'correction',
      attribution: 'user_statement',
    },
  };
});
afterEach(() => {
  unbind();
  release();
  registry.dispose();
  events.close();
});
const tools = () => sessionCredentialTools('chat', session, registry);
const call = (args = input) =>
  tools().execute('CaptureMemoryCandidate', args, session.abortController.signal);

it.each(['ask', 'pending ask'] as const)(
  'keeps %s read-only at both SDK admission and the shared capture boundary',
  async (mode) => {
    if (mode === 'ask') session.mode = 'ask';
    else session.pendingPermissionModes = new Map([[Symbol(), 'ask']]);
    const permission = (args: Record<string, unknown>) =>
      credentialSdkPermission(
        'mcp__mitzo-connections__CaptureMemoryCandidate',
        args,
        'client',
        registry,
        session,
      );
    expect(permission(input)?.behavior).toBe('deny');
    expect(permission({ action: 'sources' })?.behavior).toBe('allow');
    expect((await call({ action: 'sources' }))?.isError).toBe(false);
    const result = await call();
    expect(result?.isError).toBe(true);
    expect(result?.content).toMatch(/learning_read_only/);
    expect(events.getSessionEvents('chat').filter((e) => e.type === 'memory_candidate')).toEqual(
      [],
    );
    session.mode = 'auto';
    session.pendingPermissionModes?.clear();
    expect((await call())?.isError).toBe(false);
  },
);

it('rechecks Ask mode after asynchronous local-service preparation before committing capture', async () => {
  const local = sessionLocalServiceTools({
    sessionId: 'chat',
    session,
    registry,
    assertCurrent: async () => {
      session.mode = 'ask';
    },
    assertCurrentSync: () => {},
  });
  const result = await local.execute(
    'CaptureMemoryCandidate',
    input,
    session.abortController.signal,
    {
      assertCurrentSync: () => {},
    },
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/learning_read_only/);
  expect(events.getSessionEvents('chat').filter((e) => e.type === 'memory_candidate')).toEqual([]);
});

it('delivers durable receipt through the shared API/OpenShell tool composition and respects Off', async () => {
  expect(tools().definitions).toContainEqual(
    expect.objectContaining({ name: 'CaptureMemoryCandidate' }),
  );
  const first = await call();
  expect(first?.isError).toBe(false);
  expect(JSON.parse(first!.content)).toMatchObject({
    status: 'stored',
    knowledgeStatus: 'provisional',
  });
  expect(await call()).toEqual(first);
  events.setSessionLearningMode('chat', 'off', 0);
  const denied = await call();
  expect(denied?.isError).toBe(true);
  expect(denied?.content).toMatch(/learning_off/);
  expect(denied?.content).toMatch(/No capture was confirmed/);
  expect(events.getSessionEvents('chat').filter((e) => e.type === 'memory_candidate')).toHaveLength(
    1,
  );
  expect(sessionLearningGuidance(events.getSessionLearningPolicy('chat'))).toBe('');
});
it('rechecks operator/runtime revocation after asynchronous preparation and delivers actionable failure', async () => {
  const local = sessionLocalServiceTools({
    sessionId: 'chat',
    session,
    registry,
    assertCurrent: async () => {
      unbind();
    },
    assertCurrentSync: () => {},
  });
  const result = await local.execute(
    'CaptureMemoryCandidate',
    input,
    session.abortController.signal,
    { assertCurrentSync: () => {} },
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/No capture was confirmed/);
  expect(events.getSessionEvents('chat').filter((e) => e.type === 'memory_candidate')).toHaveLength(
    0,
  );
});
it('keeps interrupted storage failures visible to the actual tool consumer', async () => {
  vi.spyOn(events, 'captureMemoryCandidate').mockImplementationOnce(() => {
    throw Error('simulated disk failure');
  });
  const result = await call();
  expect(result?.isError).toBe(true);
  expect(result?.content).toMatch(/capture_failed/);
  expect(result?.content).toMatch(/same requestId/);
  expect((await call())?.isError).toBe(false);
});
it('registers the SDK tool without letting remember-this override Off or mutate session policy', async () => {
  expect(
    credentialSdkPermission(
      'mcp__mitzo-connections__CaptureMemoryCandidate',
      input,
      'client',
      registry,
      session,
    )?.behavior,
  ).toBe('allow');
  const sources = await call({ action: 'sources' });
  expect(JSON.parse(sources!.content)).toMatchObject({
    policy: { mode: 'auto' },
    sources: [expect.objectContaining({ messageId: 'user' })],
  });
  expect((await call({ ...input, mode: 'deep' }))?.isError).toBe(true);
  expect(events.getSessionLearningPolicy('chat').mode).toBe('auto');
});

it('rejects capture when the live adapter and controller source identity disagree', async () => {
  session.cwd = '/different-runtime';
  expect((await call())?.isError).toBe(true);
  expect(events.getSessionEvents('chat').filter((e) => e.type === 'memory_candidate')).toHaveLength(
    0,
  );
});
