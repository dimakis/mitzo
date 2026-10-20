import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { enrolledResponsesOwnerFixture } from './fixtures/enrolled-responses-owner.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { enrolledRepositorySourceFixture } from './fixtures/enrolled-repository-source.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

it('derives enrolled profile and readiness from the actual runtime, journal and created external resources', async () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  try {
    const f = await enrolledResponsesOwnerFixture(cleanup);
    expect(f.enrolled.state).toBe('ready');
    expect(f.runtime.openAIEnrollmentAuthority).toBe(f.runtime.openAIAccounts);
    expect(f.runtime.openAIEnrollmentAuthority!.manages(f.binding.accountId)).toBe(true);
    expect(loadAccountProfiles().isEnrolledOpenAIAccount(f.binding.accountId)).toBe(true);
    expect(loadAccountProfiles().configuredAccountIds()).toEqual([f.binding.accountId]);
    await expect(
      f.runtime.assertOpenAIKeyReady!(f.binding.accountId, AbortSignal.timeout(5000)),
    ).resolves.toBeUndefined();
    await expect(
      f.runtime.service.withAccountRuntime(
        f.binding.accountId,
        async () => 'original gate admitted',
      ),
    ).resolves.toBe('original gate admitted');
    expect(f.calls.requests).toEqual([
      'GET https://api.openai.com/v1/models/gpt-6-luna',
      'POST https://api.openai.com/v1/responses',
      'GET https://api.openai.com/v1/models',
    ]);
    expect(f.calls.keychain[0]).toBe('create');
    expect(f.calls.keychain.filter((call) => call === 'create')).toHaveLength(1);
    expect(f.providers.size).toBe(1);
    const source = await enrolledRepositorySourceFixture(f, cleanup);
    const { connection } = source;
    expect(source.workspace.state).toBe('ready');
    expect(source.workspace.baseOid).toBe(source.baseOid);
    expect(
      await readFile(
        join(f.root, 'private', 'repository-sources', source.workspace.id, 'mgmt', 'README.md'),
        'utf8',
      ),
    ).toContain('Actual imported bytes.');
    expect(connection.status).toBe('active');
    expect(connection.identity).toBe('offline-operator');
    expect(f.sandboxes.size).toBe(0);
    expect(
      await f.runtime.verifyGithubPublishingIdentity!(
        connection.id,
        AbortSignal.timeout(5000),
        connection.revision,
      ),
    ).toBe(true);
    const secret = [...f.secrets.values()][0];
    secret.version = randomUUID();
    await expect(
      f.runtime.assertOpenAIKeyReady!(f.binding.accountId, AbortSignal.timeout(5000)),
    ).rejects.toThrow();
    const action = vi.fn();
    await expect(
      f.runtime.service.withAccountRuntime(f.binding.accountId, action),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  } finally {
    for (const close of cleanup.reverse()) await close();
    vi.unstubAllEnvs();
  }
});
