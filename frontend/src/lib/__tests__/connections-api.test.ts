import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../api-fetch';
import { createConnection, enrollOpenAIAccount, getOpenAIAccounts } from '../connections-api';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }));
const input = {
  templateId: 'jira-readonly',
  templateVersion: 1,
  label: 'Jira',
  fields: { email: 'me@example.test' },
  credentials: { token: 'one-shot' },
  accountIds: ['work'],
  csrf: 'proof',
};
beforeEach(() => vi.resetAllMocks());
it('enrolls a new OpenAI account with an explicit operation ID, billing consent and CSRF proof', async () => {
  const account = { id: 'new-work', label: 'Work API', projectLabel: 'Research', state: 'ready' };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ account }), { status: 201 }));
  const enrollment = {
    csrf: 'proof',
    requestId: 'operation-id',
    label: 'Work API',
    projectLabel: 'Research',
    apiKey: 'ONE_SHOT_KEY',
    billingConfirmed: true as const,
  };
  await expect(enrollOpenAIAccount(enrollment)).resolves.toEqual(account);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/connections/openai-accounts',
    expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'proof' },
      body: JSON.stringify(enrollment),
    }),
  );
});
it('reads enrollment capability and public account state without credentials', async () => {
  const status = {
    enabled: true,
    accounts: [
      {
        id: 'new-work',
        requestId: 'op',
        label: 'Work API',
        projectLabel: 'Research',
        state: 'needs_attention',
      },
    ],
  };
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify(status)));
  await expect(getOpenAIAccounts()).resolves.toEqual(status);
  expect(apiFetch).toHaveBeenCalledWith('/api/connections/openai-accounts');
});
it('keeps a durable saved connection reference on verification failure', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({ error: 'Connection verification failed', savedConnectionId: 'saved-1' }),
      { status: 422 },
    ),
  );
  await expect(createConnection(input)).rejects.toMatchObject({
    connectionId: 'saved-1',
    retrySetup: false,
  });
});
it('allows setup retry only when the server confirms no saved connection', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Invalid scope', savedConnectionId: null }), {
      status: 422,
    }),
  );
  await expect(createConnection(input)).rejects.toMatchObject({
    connectionId: null,
    retrySetup: true,
  });
});
it.each(['lost-response', 'older-server', 'malformed-success'])(
  'keeps an uncertain create from becoming a second setup attempt: %s',
  async (scenario) => {
    if (scenario === 'lost-response')
      vi.mocked(apiFetch).mockRejectedValue(new Error('Network failed'));
    else
      vi.mocked(apiFetch).mockResolvedValue(
        new Response(
          JSON.stringify(scenario === 'older-server' ? { error: 'Verification failed' } : {}),
          { status: scenario === 'older-server' ? 422 : 201 },
        ),
      );
    await expect(createConnection(input)).rejects.toMatchObject({
      connectionId: null,
      retrySetup: false,
    });
  },
);

it('identifies a rejected authorization so the next attempt can request fresh identity confirmation', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ error: 'Reauthorization required' }), { status: 403 }),
  );
  await expect(createConnection(input)).rejects.toMatchObject({
    retrySetup: true,
    authorizationRequired: true,
  });
});
