import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as custody from '../claude-subscription-custody.js';
import { discoverClaudeModels } from '../claude-model-discovery.js';
import { verifyClaudeLoginIdentity } from '../claude-login-process.js';
vi.mock('../claude-model-discovery.js', () => ({ discoverClaudeModels: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(discoverClaudeModels).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-login-verification-')));
  roots.push(root);
  const executable = join(root, 'claude');
  const status = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'fixture@example.test',
    subscriptionType: 'max',
  };
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' '" + JSON.stringify(status) + "'\n", {
    mode: 0o700,
  });
  vi.spyOn(custody, 'claudeSdkExecutable').mockReturnValue(executable);
  vi.spyOn(custody.ClaudeSubscriptionCustody, 'capture').mockReturnValue({
    verify: vi.fn(async () => {}),
  } as never);
  return root;
}
it('does not report a connected account when native status passes but SDK discovery fails', async () => {
  const root = fixture();
  const failure = new custody.ClaudeSubscriptionSignInError('identity_mismatch');
  vi.mocked(discoverClaudeModels).mockRejectedValueOnce(failure);
  await expect(verifyClaudeLoginIdentity(root, new AbortController().signal)).rejects.toBe(failure);
});
it('checks the SDK using the exact native account before publishing sign-in success', async () => {
  const root = fixture();
  const signal = new AbortController().signal;
  vi.mocked(discoverClaudeModels).mockResolvedValueOnce([{ id: 'sonnet', label: 'Sonnet' }]);
  await expect(verifyClaudeLoginIdentity(root, signal)).resolves.toEqual({
    email: 'fixture@example.test',
    planType: 'max',
  });
  expect(discoverClaudeModels).toHaveBeenCalledWith(
    expect.objectContaining({
      CLAUDE_CONFIG_DIR: root,
      MITZO_CLAUDE_EXPECTED_EMAIL: 'fixture@example.test',
      MITZO_CLAUDE_EXPECTED_PLAN: 'max',
    }),
    expect.any(AbortSignal),
  );
});
