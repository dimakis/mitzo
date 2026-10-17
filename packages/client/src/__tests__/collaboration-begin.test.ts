import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { CollaborationApiClient } from '../collaboration-api.js';

const group = '00000000-0000-4000-8000-000000000001';
const input = { requestId: group, sessionId: 'ordinary-source' };
const receipt = {
  version: 1,
  collaborationId: group,
  revision: 1,
  participantSessionIds: [input.sessionId],
};
it('submits exact begin identity with existing credentials and cancellation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt)));
  const controller = new AbortController();
  await expect(
    new CollaborationApiClient(fetch).begin(group, input, controller.signal),
  ).resolves.toEqual(receipt);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/session-collaborations/${group}/begin`, {
    credentials: 'include',
    signal: controller.signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
});
it('refuses invented authority before making a request', () => {
  const fetch = vi.fn();
  expect(() =>
    new CollaborationApiClient(fetch).begin(group, { ...input, settings: {} } as typeof input),
  ).toThrow(ZodError);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { ready: true },
  { ...receipt, collaborationId: '00000000-0000-4000-8000-000000000002' },
  { ...receipt, participantSessionIds: ['other-source'] },
])('refuses a malformed or foreign receipt', async (body) => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  await expect(new CollaborationApiClient(fetch).begin(group, input)).rejects.toBeInstanceOf(
    ZodError,
  );
});
