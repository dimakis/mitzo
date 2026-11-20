import { expect, it } from 'vitest';
import {
  TurnCallbacks,
  retainCallbackOutcome,
  callbackOutcome,
  assertTurnCallbackEffects,
  observeAssistantFollowUp,
  withUncertainOutcomeNotice,
  describeToolCall,
} from '../turn-callbacks.js';
it('does not accept cloned or structural data as original effect evidence', () => {
  const result = retainCallbackOutcome(
    { isError: true, content: 'denied before execution' },
    'settled',
  );
  expect(callbackOutcome(result)).toBe('settled');
  expect(callbackOutcome({ ...result, effectStatus: 'not_started' })).toBe('unknown');
  expect(callbackOutcome(JSON.parse(JSON.stringify(result)))).toBe('unknown');
});
it('expires effect authority while retaining only original callback settlement', async () => {
  const callbacks = new TurnCallbacks();
  let finish!: () => void;
  const work = callbacks.track(async () => {
    assertTurnCallbackEffects();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assertTurnCallbackEffects();
  });
  const blockedWork = expect(work).rejects.toMatchObject({ code: 'turn_completed' });
  const blockedSettlement = expect(
    callbacks.settle(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'callbacks_failed' });
  finish();
  await blockedWork;
  await blockedSettlement;
});

it('registers and starts a callback synchronously before a following terminal notification', async () => {
  const callbacks = new TurnCallbacks();
  let started = false;
  const work = callbacks.track(async () => {
    started = true;
  });
  callbacks.seal();
  expect(started).toBe(true);
  await work;
});
it.each(['reject', 'error result'])(
  'retains an unknown %s outcome rather than releasing terminal work',
  async (kind) => {
    const callbacks = new TurnCallbacks();
    let finish!: () => void;
    const work = callbacks.track(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (kind === 'reject') throw Error('private failure after effects');
      return { isError: true, content: 'Unknown external result' };
    });
    const observed = work.catch(() => {});
    await Promise.resolve();
    const settling = callbacks.settle(new AbortController().signal);
    const blocked = expect(settling).rejects.toMatchObject({ code: 'callbacks_failed' });
    finish();
    await observed;
    await blocked;
  },
);
it('retains SDK outcomes the provider already received as uncertain without failing the turn', async () => {
  // The SDK emits its result only after every tool result reached the model, so an
  // unknown effect that finished before seal is advisory evidence, not a stuck turn.
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  await callbacks.track(async () => ({ isError: true, content: 'Command timed out' }));
  await callbacks
    .track(async () => {
      throw Error('private failure after effects');
    })
    .catch(() => {});
  await callbacks.track(async () =>
    retainCallbackOutcome({ isError: true, content: 'Refused before execution' }, 'settled'),
  );
  expect(callbacks.uncertainOutcomes).toBe(2);
  await expect(callbacks.settle(new AbortController().signal)).resolves.toBeUndefined();
  expect(callbacks.uncertainOutcomes).toBe(2);
});
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { content },
  ...extra,
});
it('does not raise the uncertain-outcome notice once the agent follows up in text', async () => {
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  await callbacks.track(async () => ({ isError: true, content: 'Command timed out' }));
  expect(callbacks.uncertainOutcomes).toBe(1);
  observeAssistantFollowUp(
    assistant([{ type: 'text', text: 'That timed out; inspecting.' }]),
    callbacks,
  );
  expect(callbacks.uncertainOutcomes).toBe(0);
  expect(withUncertainOutcomeNotice({ type: 'result' }, callbacks)).toEqual({ type: 'result' });
});
it('still raises the notice for an outcome that follows the last text or has no follow-up', async () => {
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  await callbacks.track(async () => ({ isError: true, content: 'first' }));
  observeAssistantFollowUp(assistant([{ type: 'text', text: 'Handled the first.' }]), callbacks);
  await callbacks.track(async () => ({ isError: true, content: 'second' }));
  expect(callbacks.uncertainOutcomes).toBe(1);
  expect(withUncertainOutcomeNotice({ type: 'result' }, callbacks)).toMatchObject({
    tool_failure_notice: true,
  });
});
it.each([
  ['a tool-only message', assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])],
  ['thinking', assistant([{ type: 'thinking', thinking: 'hmm' }])],
  ['blank text', assistant([{ type: 'text', text: '  ' }])],
  ['a sub-agent message', assistant([{ type: 'text', text: 'sub' }], { parent_tool_use_id: 'x' })],
  ['a user message', { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }],
])('does not treat %s as a follow-up', async (_name, event) => {
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  await callbacks.track(async () => ({ isError: true, content: 'timed out' }));
  observeAssistantFollowUp(event, callbacks);
  expect(callbacks.uncertainOutcomes).toBe(1);
});
it('still fails an SDK turn whose callback settles unknown only after the result sealed it', async () => {
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  let finish!: () => void;
  const work = callbacks.track(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { isError: true, content: 'Unknown external result' };
  });
  const settling = callbacks.settle(new AbortController().signal);
  const blocked = expect(settling).rejects.toMatchObject({ code: 'callbacks_failed' });
  finish();
  await work;
  await blocked;
});
it('describes a tool call by its top-level request ID only, never other input values', () => {
  const described = describeToolCall(
    'mcp__telos__TelosCreateChild',
    { requestId: 'create-slice-10', summary: 'private plan', nested: { requestId: 'inner' } },
    { toolUseId: 'use-1', requestHash: 'hash-1' },
  );
  expect(described).toEqual({
    tool: 'mcp__telos__TelosCreateChild',
    toolUseId: 'use-1',
    requestHash: 'hash-1',
    requestId: 'create-slice-10',
  });
  expect(JSON.stringify(described)).not.toContain('private plan');
  expect(JSON.stringify(described)).not.toContain('inner');
  for (const requestId of [42, 'has space', '', 'x'.repeat(201), { a: 1 }])
    expect(describeToolCall('Tool', { requestId }, {})).not.toHaveProperty('requestId');
});
it('retains which operations are uncertain, with their original request IDs, and never replays them', async () => {
  const callbacks = new TurnCallbacks({ retainUnknownOutcomes: true });
  let runs = 0;
  await callbacks.track(
    async () => {
      runs++;
      return { isError: true, content: 'Telos item operation unavailable' };
    },
    undefined,
    describeToolCall(
      'TelosCreateChild',
      { requestId: 'req-1', summary: 'secret' },
      { toolUseId: 'u1' },
    ),
  );
  await callbacks
    .track(
      async () => {
        throw Error('private failure after effects');
      },
      undefined,
      describeToolCall('TelosUpdateItem', { requestId: 'req-2' }, { toolUseId: 'u2' }),
    )
    .catch(() => {});
  // A refusal the owner settled is not uncertain and is not listed.
  await callbacks.track(
    async () => retainCallbackOutcome({ isError: true, content: 'expired' }, 'settled'),
    undefined,
    describeToolCall('TelosCreateFeature', { requestId: 'req-3' }, {}),
  );
  expect(callbacks.uncertainOperations).toEqual([
    { tool: 'TelosCreateChild', toolUseId: 'u1', requestId: 'req-1' },
    { tool: 'TelosUpdateItem', toolUseId: 'u2', requestId: 'req-2' },
  ]);
  const notice = withUncertainOutcomeNotice({ type: 'result' }, callbacks) as Record<
    string,
    unknown
  >;
  expect(notice).toMatchObject({
    tool_failure_notice: true,
    uncertain_operations: [
      { tool: 'TelosCreateChild', requestId: 'req-1' },
      { tool: 'TelosUpdateItem', requestId: 'req-2' },
    ],
  });
  expect(JSON.stringify(notice)).not.toContain('secret');
  expect(runs).toBe(1);
  // Following up in text explains them, as before.
  observeAssistantFollowUp(assistant([{ type: 'text', text: 'Checking state.' }]), callbacks);
  expect(callbacks.uncertainOperations).toEqual([]);
});
