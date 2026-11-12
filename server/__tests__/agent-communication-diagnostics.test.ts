import { expect, it } from 'vitest';
import { executeAgentCommunicationTool } from '../agent-communication-tools.js';
import { AgentCommunicationError } from '../agent-message-runtime.js';
import { retainCallbackOutcome, retainedCallbackOutcome } from '../turn-callbacks.js';

it('projects capability refusal through the tool consumer with stable identifiers and the original settlement classification', async () => {
  const error = retainCallbackOutcome(
    new AgentCommunicationError(
      'runtime_unsupported',
      'capability',
      'This runtime has no verified active-turn adapter.',
    ),
    'settled',
  );
  const requestId = '00000000-0000-4000-8000-000000000001';
  const result = await executeAgentCommunicationTool(
    async () => {
      throw error;
    },
    { conversationId: 'sender', requestId, recipientConversationId: 'worker' },
  );
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content)).toMatchObject({
    code: 'runtime_unsupported',
    stage: 'capability',
    requestId,
    recipientConversationId: 'worker',
  });
  expect(retainedCallbackOutcome(result)).toBe('settled');
});

it('sanitizes an unexpected failure and does not turn uncertainty into a settled result', async () => {
  const result = await executeAgentCommunicationTool(
    async () => {
      throw Error('private-provider-payload SECRET');
    },
    { conversationId: 'sender' },
  );
  expect(result.isError).toBe(true);
  expect(result.content).not.toMatch(/SECRET|private-provider-payload/);
  expect(JSON.parse(result.content)).toMatchObject({ code: 'agent_communication_unavailable' });
  expect(retainedCallbackOutcome(result)).toBeUndefined();
});
