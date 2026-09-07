import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { resolvePending } from '../src/permissions.js';

const registries: SessionRegistry[] = [];
afterEach(() => {
  for (const r of registries) r.dispose();
  registries.length = 0;
});
const questions = [
  {
    question: 'Which account?',
    header: 'Account',
    multiSelect: false,
    options: [
      { label: 'Personal', description: 'ChatGPT plan' },
      { label: 'Work', description: 'Enterprise billing' },
    ],
  },
];
function setup() {
  const registry = new SessionRegistry();
  registries.push(registry);
  const sent: Record<string, unknown>[] = [];
  const abort = new AbortController();
  registry.register('client', {
    transport: {
      send: (m) => {
        sent.push(m);
      },
      isOpen: () => true,
    },
    abortController: abort,
    mode: 'auto',
    sessionId: 'conversation',
    sessionAllowList: new Set(['AskUserQuestion']),
  });
  return { registry, sent, abort, handler: buildPermissionHandler('client', registry) };
}
it('shows structured questions even after a prior session allow, then returns actual answers to the SDK', async () => {
  const { handler, sent, abort } = setup();
  const result = handler(
    'AskUserQuestion',
    { questions },
    { signal: abort.signal, toolUseID: 'q1' },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  expect(sent[0]).toMatchObject({
    type: 'permission_request',
    sessionId: 'conversation',
    questions: [{ id: 'Which account?', ...questions[0] }],
  });
  expect(sent[0].expiresAt).toEqual(expect.any(Number));
  expect(resolvePending(sent[0].permId as string, 'once', { 'Which account?': ['Personal'] })).toBe(
    true,
  );
  await expect(result).resolves.toMatchObject({
    behavior: 'allow',
    updatedInput: {
      questions,
      answers: { 'Which account?': 'Personal' },
    },
  });
});
it('does not consume a question on empty answers or an always-allow response', async () => {
  const { handler, sent, abort } = setup();
  const result = handler(
    'AskUserQuestion',
    { questions },
    { signal: abort.signal, toolUseID: 'q1' },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  const id = sent[0].permId as string;
  expect(resolvePending(id, 'once')).toBe(false);
  expect(resolvePending(id, 'always', { 'Which account?': ['Personal'] })).toBe(false);
  expect(resolvePending(id, 'once', { 'Which account?': ['Personal', 'Work'] })).toBe(false);
  expect(resolvePending(id, 'deny')).toBe(true);
  await expect(result).resolves.toMatchObject({ behavior: 'deny' });
});
it('denies malformed questions rather than showing a generic tool approval', async () => {
  const { handler, sent, abort } = setup();
  await expect(
    handler('AskUserQuestion', { questions: [] }, { signal: abort.signal, toolUseID: 'q1' }),
  ).resolves.toMatchObject({ behavior: 'deny' });
  expect(sent).toHaveLength(0);
});
it('cancellation removes the pending question and its timers', async () => {
  vi.useFakeTimers();
  try {
    const { handler, sent, abort } = setup();
    const result = handler(
      'AskUserQuestion',
      { questions },
      { signal: abort.signal, toolUseID: 'q1' },
    );
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
    expect(
      resolvePending(sent[0].permId as string, 'once', { 'Which account?': ['Personal'] }),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('replays only unresolved prompts with the original deadline and protects session identity', async () => {
  const { getPendingRequestsBySession } = await import('../src/permissions.js');
  const { handler, sent, abort } = setup();
  const result = handler(
    'AskUserQuestion',
    { questions },
    { signal: abort.signal, toolUseID: 'q1' },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  const request = getPendingRequestsBySession('conversation')[0];
  expect(request.permId).toBe(sent[0].permId);
  expect(request.expiresAt).toBe(sent[0].expiresAt);
  expect(resolvePending(request.permId, 'deny', undefined, 'other-session')).toBe(false);
  expect(
    resolvePending(request.permId, 'once', { 'Which account?': ['Personal'] }, 'conversation'),
  ).toBe(true);
  await result;
  expect(getPendingRequestsBySession('conversation')).toEqual([]);
  expect(sent).toContainEqual({
    type: 'permission_resolved',
    permId: request.permId,
    sessionId: 'conversation',
  });
});

it('shows complete approval arguments rather than the notification summary', async () => {
  const { applyTierOverrides } = await import('../src/tool-tiers.js');
  applyTierOverrides({ Bash: 'unknown' });
  try {
    const { handler, sent, abort } = setup();
    const command = 'echo ' + 'long-command '.repeat(60);
    const result = handler('Bash', { command }, { signal: abort.signal, toolUseID: 'b1' });
    await vi.waitFor(() => expect(sent[0]).toBeDefined());
    expect(sent[0].toolInput).toContain(command);
    resolvePending(sent[0].permId as string, 'deny');
    await result;
  } finally {
    applyTierOverrides({});
  }
});

it('keeps an unresolved question replayable when a transport closes during send', async () => {
  const { getPendingRequestsBySession } = await import('../src/permissions.js');
  const { handler, registry, abort } = setup();
  registry.get('client')!.transport.send = () => {
    throw new Error('socket closed');
  };
  const result = handler(
    'AskUserQuestion',
    { questions },
    { signal: abort.signal, toolUseID: 'q1' },
  );
  const checked = expect(result).resolves.toMatchObject({ behavior: 'deny' });
  await vi.waitFor(() => expect(getPendingRequestsBySession('conversation')).toHaveLength(1));
  expect(() =>
    resolvePending(getPendingRequestsBySession('conversation')[0].permId, 'deny'),
  ).not.toThrow();
  await checked;
});
