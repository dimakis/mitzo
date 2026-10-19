import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { CollaborationApiClient } from '../collaboration-api.js';

const group = '00000000-0000-4000-8000-000000000001';
const input = {
  selection: {
    requestId: group,
    expectedMembershipRevision: 1,
    sourceConversationId: 'source',
    boundary: { sequence: 4, messageId: 'question' },
    mode: 'conversation_so_far' as const,
    messageIds: [],
    artifacts: [],
    purpose: 'Review',
    joiningBrief: 'Edited brief',
  },
  target: {
    runOn: 'openshell' as const,
    accountId: 'api-account',
    model: 'recording-model',
    reasoningEffort: null,
    agent: { profileId: 'published-agent', revision: 2 },
    repositoryWorkspaceId: 'prepared-workspace',
    permissionMode: 'ask' as const,
  },
};
it('sends the exact selectors and transport reference, preserving cancellation and refusal', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 'execution_unavailable',
        error: 'Native capacity unavailable',
      }),
      { status: 503 },
    ),
  );
  const api = new CollaborationApiClient(fetch);
  const controller = new AbortController();
  await expect(
    api.review(group, 'actual-transport', input, controller.signal),
  ).rejects.toMatchObject({ status: 503, code: 'execution_unavailable' });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/session-collaborations/${group}/reviews`, {
    credentials: 'include',
    signal: controller.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, clientId: 'actual-transport' }),
  });
});
it('rejects invented authority or missing transport reference before fetching', () => {
  const fetch = vi.fn();
  const api = new CollaborationApiClient(fetch);
  expect(() => api.review(group, '', input)).toThrow(ZodError);
  expect(() => api.review(group, 'transport', { ...input, settings: {} } as typeof input)).toThrow(
    ZodError,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects an invalid review response instead of treating HTTP success as readiness', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ready: true }), { status: 200 }));
  await expect(
    new CollaborationApiClient(fetch).review(group, 'transport', input),
  ).rejects.toBeInstanceOf(ZodError);
});
