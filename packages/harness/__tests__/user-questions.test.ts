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
it('does not consume a question on empty or invalid answers', async () => {
  const { handler, sent, abort } = setup();
  const result = handler(
    'AskUserQuestion',
    { questions },
    { signal: abort.signal, toolUseID: 'q1' },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  const id = sent[0].permId as string;
  expect(resolvePending(id, 'once')).toBe(false);
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

it('accepts every offered multi-select option plus a written answer through both protocols', async () => {
  const { V2PermissionResponseMessage, PermissionResponseMessage } =
    await import('@mitzo/protocol');
  const { handler, sent, abort } = setup();
  const options = Array.from({ length: 8 }, (_, i) => ({ label: `Option ${i}`, description: '' }));
  const result = handler(
    'AskUserQuestion',
    { questions: [{ question: 'Features', options, multiSelect: true }] },
    { signal: abort.signal, toolUseID: 'q1' },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  const answers = { Features: [...options.map((o) => o.label), 'Also voice'] };
  const response = {
    type: 'permission_response',
    permId: sent[0].permId as string,
    decision: 'once',
    answers,
  };
  expect(V2PermissionResponseMessage.safeParse(response).success).toBe(true);
  expect(PermissionResponseMessage.safeParse(response).success).toBe(true);
  expect(resolvePending(response.permId, 'once', answers)).toBe(true);
  await expect(result).resolves.toMatchObject({
    behavior: 'allow',
    updatedInput: { answers: { Features: JSON.stringify(answers.Features) } },
  });
});

it('treats an always decision on a question as one-shot and preserves commas', async () => {
  const { handler, sent, abort } = setup();
  const result = handler(
    'AskUserQuestion',
    { questions: [{ question: 'Values', options: [], multiSelect: true }] },
    { signal: abort.signal, toolUseID: 'q-always' },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  expect(resolvePending(sent[0].permId as string, 'always', { Values: ['a, b', 'c'] })).toBe(true);
  await expect(result).resolves.toMatchObject({
    behavior: 'allow',
    decisionClassification: 'user_temporary',
    updatedInput: { answers: { Values: JSON.stringify(['a, b', 'c']) } },
  });
});

it.each(['abort', 'timeout'])('broadcasts exactly one terminal event on %s', async (cause) => {
  vi.useFakeTimers();
  try {
    const { handler, sent, abort } = setup();
    const result = handler(
      'AskUserQuestion',
      { questions },
      { signal: abort.signal, toolUseID: 'q1' },
    );
    await vi.advanceTimersByTimeAsync(0);
    if (cause === 'abort') abort.abort();
    else await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
    expect(
      sent.filter((m) => m.type === 'permission_resolved' || m.type === 'permission_timeout'),
    ).toEqual([{ type: 'permission_timeout', permId: sent[0].permId, sessionId: 'conversation' }]);
  } finally {
    vi.useRealTimers();
  }
});

it('preserves native question IDs and rejects free text when choices are restricted', async () => {
  const { handler, sent, abort } = setup();
  const result = handler(
    'AskUserQuestion',
    {},
    {
      signal: abort.signal,
      toolUseID: 'native-q',
      questions: [{ ...questions[0], id: 'provider-q', allowFreeform: false }],
    },
  );
  await vi.waitFor(() => expect(sent[0]?.questions).toBeDefined());
  expect(resolvePending(sent[0].permId as string, 'once', { 'provider-q': ['Other'] })).toBe(false);
  expect(resolvePending(sent[0].permId as string, 'once', { 'provider-q': ['Work'] })).toBe(true);
  await expect(result).resolves.toMatchObject({
    behavior: 'allow',
    updatedInput: { answers: { 'Which account?': 'Work' } },
  });
});
