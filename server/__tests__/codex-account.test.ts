import { expect, it, vi } from 'vitest';
import { verifyCodexAccount } from '../codex-account.js';

const profile = {
  accountId: 'personal',
  accountLabel: 'Personal ChatGPT',
  credentialRef: '/private/codex',
  email: 'person@example.test',
  planType: 'prolite',
  model: 'test-model',
};
function rpc(
  account: unknown = { type: 'chatgpt', email: profile.email, planType: profile.planType },
) {
  return { request: vi.fn().mockResolvedValue({ account, requiresOpenaiAuth: true }) };
}
it('binds the explicit login, account, plan and model without exposing the login path', async () => {
  const client = rpc();
  const binding = await verifyCodexAccount(client, profile);
  expect(binding).toMatchObject({
    accountId: 'personal',
    provider: 'openai-codex',
    model: 'test-model',
  });
  expect(JSON.stringify(binding)).not.toContain('/private/codex');
  expect(client.request.mock.calls).toEqual([['account/read', { refreshToken: false }]]);
  await expect(verifyCodexAccount(rpc(), profile, binding)).resolves.toEqual(binding);
});
it.each([
  null,
  { type: 'apiKey' },
  { type: 'amazonBedrock' },
  { type: 'chatgpt', email: 'other@example.test', planType: 'prolite' },
  { type: 'chatgpt', email: profile.email, planType: 'business' },
])(
  'rejects an absent or mismatched account before any model or tool operation: %j',
  async (account) => {
    const client = rpc(account);
    await expect(verifyCodexAccount(client, profile)).rejects.toThrow(
      'Codex account does not match',
    );
    expect(client.request).toHaveBeenCalledTimes(1);
  },
);
it('rejects binding changes before contacting the process', async () => {
  const stored = await verifyCodexAccount(rpc(), profile);
  for (const change of [
    { model: 'different' },
    { credentialRef: '/other/login' },
    { email: 'other@example.test' },
    { planType: 'pro' },
    { accountId: 'other' },
  ]) {
    const client = rpc();
    await expect(verifyCodexAccount(client, { ...profile, ...change }, stored)).rejects.toThrow(
      'bound',
    );
    expect(client.request).not.toHaveBeenCalled();
  }
});
it('rejects invalid profiles and malformed account responses without echoing secrets', async () => {
  const client = { request: vi.fn().mockResolvedValue({ secret: 'private-secret' }) };
  const rejected = verifyCodexAccount(client, profile);
  await expect(rejected).rejects.toThrow('Codex account does not match');
  await expect(rejected).rejects.not.toThrow('private-secret');
  await expect(
    verifyCodexAccount(client, { ...profile, credentialRef: 'relative' }),
  ).rejects.toThrow('Invalid Codex account profile');
});
