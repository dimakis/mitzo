import { afterEach, expect, it, vi } from 'vitest';
import {
  executeTelosWorkTool,
  TelosStartSliceInputSchema,
  telosWorkDefinitions,
} from '../telos-work-tools.js';
import { agentToolCatalog } from '../agent-tool-catalog.js';
import { assertAgentToolRoute } from '../agent-tool-selection.js';

const input = {
  requestId: 'start-request',
  childItemId: 'slice-one',
  mode: 'start' as const,
  predecessorAttemptId: null,
};
const receipt = {
  version: 1,
  state: 'chat_ready',
  execution: 'not_started',
  workerConversationId: 'worker-chat',
  workerPath: '/chat/worker-chat',
  itemPath: '/todos/slice-one',
  leadPath: '/chat/lead-chat',
  attempt: {
    version: 1,
    requestId: 'original-request',
    attemptId: 'attempt-one',
    predecessorAttemptId: null,
    leadConversationId: 'lead-chat',
    childItemId: 'slice-one',
    contextSnapshotId: 'snapshot-one',
    state: 'chat_ready',
    workerConversationId: 'worker-chat',
    allocationReceiptId: 'allocation',
    executionTaskId: 'task-one',
    accountingGoalId: null,
    turnCommandId: null,
  },
};
afterEach(() => vi.unstubAllGlobals());

it('retains held catalog route activation for the newly registered mutation', () => {
  expect(agentToolCatalog().find((tool) => tool.name === 'TelosStartSlice')).toMatchObject({
    behavior: 'write',
    routes: [],
  });
  expect(() =>
    assertAgentToolRoute(
      { tools: [{ id: 'mitzo:TelosStartSlice', version: 1 }] } as never,
      'local-api',
    ),
  ).toThrow(/unavailable/);
  expect(() =>
    assertAgentToolRoute(
      { tools: [{ id: 'mitzo:TelosStartSlice', version: 1 }] } as never,
      'native-codex',
    ),
  ).toThrow(/not supported/);
});

it('offers one exact allocation-only slice tool with no model-turn or implicit retry fields', () => {
  expect(telosWorkDefinitions.map((tool) => tool.name)).toEqual(['TelosStartSlice']);
  expect(telosWorkDefinitions[0].description).toContain('does not start a model turn');
  for (const invalid of [
    { ...input, childItemId: '' },
    { ...input, leadConversationId: 'spoof' },
    { ...input, mode: 'retry' },
    { ...input, predecessorAttemptId: 'previous' },
    { ...input, settings: {} },
    { ...input, prompt: 'start every slice' },
  ])
    expect(TelosStartSliceInputSchema.safeParse(invalid).success).toBe(false);
});

it('posts the exact current client/session and returns only a verified canonical allocation receipt', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt)));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const result = await executeTelosWorkTool(
    'http://host',
    'client',
    'lead-chat',
    'secret',
    'TelosStartSlice',
    input,
    signal,
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content)).toEqual(receipt);
  expect(fetch).toHaveBeenCalledWith(
    'http://host/api/internal/telos/work/delegate',
    expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': 'secret',
        'X-Client-Id': 'client',
      },
      body: JSON.stringify({ clientId: 'client', sessionId: 'lead-chat', input }),
      signal,
    }),
  );
});

it('rejects absent identity, cancellation and invalid requests before contacting the host', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const [clientId, sessionId] of [
    ['', 'lead-chat'],
    ['client', ''],
    [' ', 'lead-chat'],
  ]) {
    expect(
      (
        await executeTelosWorkTool(
          'http://host',
          clientId,
          sessionId,
          'secret',
          'TelosStartSlice',
          input,
        )
      ).isError,
    ).toBe(true);
  }
  expect(
    (
      await executeTelosWorkTool(
        'http://host',
        'client',
        'lead-chat',
        'secret',
        'TelosStartSlice',
        { ...input, childItemId: 'ambiguous child' },
      )
    ).isError,
  ).toBe(true);
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await executeTelosWorkTool(
        'http://host',
        'client',
        'lead-chat',
        'secret',
        'TelosStartSlice',
        input,
        controller.signal,
      )
    ).isError,
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  { ...receipt, execution: 'running' },
  { ...receipt, workerPath: '/chat/another' },
  { ...receipt, attempt: { ...receipt.attempt, childItemId: 'other-slice' } },
  { ...receipt, attempt: { ...receipt.attempt, leadConversationId: 'another-lead' } },
  { ...receipt, attempt: { ...receipt.attempt, workerConversationId: 'different-worker' } },
  { ...receipt, attempt: { ...receipt.attempt, state: 'requested' } },
  { ...receipt, attempt: { ...receipt.attempt, turnCommandId: 'unrequested-turn' } },
  { ok: true },
])('never claims success from malformed or mismatched allocation evidence %#', async (body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  expect(
    (
      await executeTelosWorkTool(
        'http://host',
        'client',
        'lead-chat',
        'secret',
        'TelosStartSlice',
        input,
      )
    ).isError,
  ).toBe(true);
});

it('preserves failure and uncertainty without substituting a new request or claiming execution', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Lead assignment changed' }), { status: 403 }),
      )
      .mockRejectedValueOnce(new Error('response lost')),
  );
  expect(
    await executeTelosWorkTool(
      'http://host',
      'client',
      'lead-chat',
      'secret',
      'TelosStartSlice',
      input,
    ),
  ).toEqual({ content: 'Lead assignment changed', isError: true });
  const uncertain = await executeTelosWorkTool(
    'http://host',
    'client',
    'lead-chat',
    'secret',
    'TelosStartSlice',
    input,
  );
  expect(uncertain.isError).toBe(true);
  expect(uncertain.content).toContain('same requestId');
});
