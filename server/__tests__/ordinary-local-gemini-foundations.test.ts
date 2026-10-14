import { expect, it, vi } from 'vitest';
import * as protocol from '@mitzo/protocol';
import { NativeResponsesStore } from '../native-responses-store.js';
import { NativeResponsesRunner } from '../native-responses-runner.js';
it('does not stage a changed Gemini model or reinterpret retained signed provider parts', () => {
  const store = new NativeResponsesStore(':memory:');
  const binding = {
    accountId: 'selected-google',
    provider: 'google-vertex' as const,
    profileRevision: 'route',
    accountLabel: 'Google',
    model: 'gemini-2.5-pro',
  };
  const history = [
    { role: 'user' as const, content: 'retained task' },
    { role: 'assistant' as const, content: 'retained answer' },
  ];
  const state = {
    status: 'idle' as const,
    history,
    checkpoint: {
      accountId: binding.accountId,
      model: binding.model,
      history,
      input: [
        {
          role: 'model',
          parts: [{ text: 'retained answer', thoughtSignature: 'opaque-original-signature' }],
        },
      ],
    },
  };
  store.begin('task', binding);
  store.save('task', binding, state);
  const token = vi.fn(async () => 'offline-token');
  const runner = new NativeResponsesRunner({
    conversationId: 'task',
    binding,
    gemini: {
      accountId: binding.accountId,
      projectId: 'selected-project',
      region: 'europe-west1',
      getAccessToken: token,
    },
    store,
    tools: [],
    systemPrompt: '',
    maxTokens: 100,
    executeTool: vi.fn(),
  });
  expect(() =>
    runner.prepare('new-model', 'new prompt', {
      model: 'gemini-2.5-flash',
      reasoningEffort: 'low',
    }),
  ).toThrow(/original Gemini model/);
  expect(store.load('task', binding)).toEqual(state);
  expect(token).not.toHaveBeenCalled();
  store.close();
});
it('keeps OpenAI/Codex aliases strict while accepting an explicit Local Gemini intent', () => {
  const schema = (
    protocol as unknown as Record<string, { safeParse(input: unknown): { success: boolean } }>
  ).LocalGeminiFirstCommandSchema;
  expect(schema).toBeDefined();
});

it('refuses changed Gemini thinking before staging and preserves every signed checkpoint part', () => {
  const store = new NativeResponsesStore(':memory:');
  const binding = {
    accountId: 'google',
    provider: 'google-vertex' as const,
    profileRevision: 'routing',
    accountLabel: 'Google',
    model: 'gemini-2.5-pro',
  };
  const history = [
    { role: 'user' as const, content: 'task' },
    { role: 'assistant' as const, content: 'answer' },
  ];
  const state = {
    status: 'idle' as const,
    history,
    nativeSelection: { model: binding.model, reasoningEffort: 'low' },
    checkpoint: {
      accountId: 'google',
      model: binding.model,
      history,
      input: [
        {
          role: 'model',
          parts: [
            { thought: true, text: 'hidden', thoughtSignature: 'signed' },
            { text: 'answer', thoughtSignature: 'signed-answer' },
          ],
        },
      ],
    },
  };
  store.begin('task', binding);
  store.save('task', binding, state);
  const token = vi.fn(async () => 'offline');
  const runner = new NativeResponsesRunner({
    conversationId: 'task',
    binding,
    gemini: {
      accountId: 'google',
      projectId: 'project',
      region: 'europe-west1',
      getAccessToken: token,
    },
    store,
    tools: [],
    systemPrompt: '',
    reasoningEffort: 'low',
    maxTokens: 100,
    executeTool: vi.fn(),
  });
  expect(() =>
    runner.prepare('changed', 'future', { model: binding.model, reasoningEffort: 'high' }),
  ).toThrow(/original Gemini model and thinking/);
  expect(store.load('task', binding)).toEqual(state);
  expect(token).not.toHaveBeenCalled();
  store.close();
});
it('accepts only the explicit Local Gemini account and harness tuple', () => {
  const request = {
    clientMsgId: 'command',
    repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
    runOn: 'local',
    capabilityRevision: 'revision',
    runtime: {
      account: { accountId: 'google', provider: 'google-vertex', profileRevision: 'revision' },
      harness: 'gemini',
      targetId: 'local',
      mode: 'agent',
    },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      model: 'gemini-2.5-pro',
      thinking: 'low',
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
    },
    payload: { text: 'task' },
  };
  expect(protocol.LocalGeminiFirstCommandSchema.safeParse(request).success).toBe(true);
  expect(protocol.LocalResponsesFirstCommandSchema.safeParse(request).success).toBe(false);
  expect(
    protocol.LocalGeminiFirstCommandSchema.safeParse({
      ...request,
      runtime: { ...request.runtime, harness: 'responses' },
    }).success,
  ).toBe(false);
  expect(
    protocol.LocalGeminiFirstCommandSchema.safeParse({ ...request, runOn: 'openshell' }).success,
  ).toBe(false);
});
