import { expect, it } from 'vitest';
import { AsyncQueue, type ExecutionToken } from '@mitzo/protocol';
import { executionBoundQuery, executionBoundSdkPrompt, makeProviderTurnBinding } from '../chat.js';

const oldToken: ExecutionToken = {
  sessionId: 'token-envelope-session',
  executionId: 'old-turn',
  generation: 1,
};
const replacementToken: ExecutionToken = {
  sessionId: 'token-envelope-session',
  executionId: 'replacement-turn',
  generation: 2,
};

it('keeps a predecessor result on its token when the SDK pulls replacement input first', async () => {
  const input = new AsyncQueue<{
    executionToken: ExecutionToken;
    message: { type: 'user'; parent_tool_use_id: null; message: { role: 'user'; content: string } };
  }>();
  const binding = makeProviderTurnBinding();
  const prompts = executionBoundSdkPrompt(input, binding)[Symbol.asyncIterator]();

  input.push({
    executionToken: oldToken,
    message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'old' } },
  });
  await expect(prompts.next()).resolves.toMatchObject({ value: { message: { content: 'old' } } });

  // Some Anthropic SDK versions ask for their next input before yielding the
  // previous result. The replacement pull must wait for that old boundary.
  input.push({
    executionToken: replacementToken,
    message: {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'replacement' },
    },
  });
  const replacementPull = prompts.next();
  let replacementPulled = false;
  void replacementPull.then(() => {
    replacementPulled = true;
  });
  await Promise.resolve();
  expect(replacementPulled).toBe(false);

  async function* predecessorResult() {
    yield { type: 'result', subtype: 'success' } as Record<string, unknown>;
  }
  const output = executionBoundQuery(predecessorResult() as never, binding);
  const result = await output[Symbol.asyncIterator]().next();
  expect(result.value).toMatchObject({ type: 'result', mitzoExecutionToken: oldToken });

  await expect(replacementPull).resolves.toMatchObject({
    value: { message: { content: 'replacement' } },
  });
  expect(binding.token).toEqual(replacementToken);
  input.close();
});

it('does not let an untagged legacy result inherit a queued FIFO token', async () => {
  const input = new AsyncQueue<{
    executionToken?: ExecutionToken;
    message: { type: 'user'; parent_tool_use_id: null; message: { role: 'user'; content: string } };
  }>();
  const binding = makeProviderTurnBinding();
  const prompts = executionBoundSdkPrompt(input, binding)[Symbol.asyncIterator]();

  input.push({
    message: {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'legacy initial turn' },
    },
  });
  await expect(prompts.next()).resolves.toMatchObject({
    value: { message: { content: 'legacy initial turn' } },
  });

  input.push({
    executionToken: replacementToken,
    message: {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'FIFO follow-up' },
    },
  });
  const followUpPull = prompts.next();
  let pulled = false;
  void followUpPull.then(() => {
    pulled = true;
  });
  await Promise.resolve();
  expect(pulled).toBe(false);

  async function* legacyResult() {
    yield { type: 'result', subtype: 'success' } as Record<string, unknown>;
  }
  const result = await executionBoundQuery(legacyResult() as never, binding)
    [Symbol.asyncIterator]()
    .next();
  expect(result.value).toMatchObject({ type: 'result' });
  expect(result.value).not.toHaveProperty('mitzoExecutionToken');

  await expect(followUpPull).resolves.toMatchObject({
    value: { message: { content: 'FIFO follow-up' } },
  });
  expect(binding.token).toEqual(replacementToken);
  input.close();
});
