import { expect, it } from 'vitest';
import {
  OrdinaryRuntimeFirstCommandSchema,
  OrdinaryRuntimeContinuationCommandSchema,
  OrdinaryCodexFirstCommandSchema,
  LocalCodexFirstCommandSchema,
} from '../local-codex-first-command.js';
const request = {
  runOn: 'local',
  repositoryWorkspaceId: '12345678-1234-4234-8234-123456789012',
  clientMsgId: 'command',
  capabilityRevision: 'revision',
  runtime: {
    account: { accountId: 'api', provider: 'openai', profileRevision: 'profile' },
    harness: 'responses',
    targetId: 'mac-api',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'developer', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-model',
    thinking: 'high',
  },
  payload: { text: 'Implement task' },
};
it('accepts exact Local Responses through generic runtime while preserving Codex aliases', () => {
  expect(OrdinaryRuntimeFirstCommandSchema.safeParse(request).success).toBe(true);
  expect(
    OrdinaryRuntimeContinuationCommandSchema.safeParse({ ...request, sessionId: 'retained' })
      .success,
  ).toBe(true);
  expect(OrdinaryCodexFirstCommandSchema.safeParse(request).success).toBe(false);
  expect(LocalCodexFirstCommandSchema.safeParse(request).success).toBe(false);
});
it.each([
  { runOn: 'openshell' },
  {
    runtime: {
      ...request.runtime,
      account: { ...request.runtime.account, provider: 'openai-codex' },
    },
  },
  { runtime: { ...request.runtime, mode: 'auto' } },
])('refuses incompatible Responses tuples and permission drift', (change) => {
  expect(OrdinaryRuntimeFirstCommandSchema.safeParse({ ...request, ...change }).success).toBe(
    false,
  );
});
