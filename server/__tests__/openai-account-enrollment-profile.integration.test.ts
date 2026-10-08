import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { loadAccountProfiles } from '../account-profiles.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
import { createConnectionsRouter } from '../connections-router.js';
import { ConnectionStore } from '../connections-store.js';
import { ConnectionsService } from '../connections-service.js';
import { createConnectionsRuntime } from '../connections-runtime.js';
import {
  OpenAIAccountEnrollment,
  OpenAIAccountEnrollmentStore,
} from '../openai-account-enrollment.js';
import { openAIEnrollmentCredentialReference } from '../openai-account-enrollment-keychain.js';
import { discoverOpenAIEnrollmentModels } from '../openai-enrollment-models.js';

vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.unstubAllEnvs();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openai-profile-integration-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const journal = join(directory, 'private', 'enrollments.db');
  const profilesPath = join(directory, 'accounts.json');
  const legacy = {
    id: 'old-work',
    label: 'Existing Work',
    provider: 'openai',
    credentialRef: { provider: 'keychain', service: 'old.work', account: 'api-key' },
    sandboxProvider: 'old-work-provider',
    sandboxProviderId: 'old-provider-id',
    models: [{ id: 'gpt-6-luna', label: 'Luna 6', reasoningEfforts: ['low'] }],
  };
  writeFileSync(profilesPath, JSON.stringify([legacy]));
  const store = new OpenAIAccountEnrollmentStore(journal);
  const connections = new ConnectionStore(join(directory, 'connections.db'));
  cleanup.push(() => {
    store.close();
    connections.close();
  });
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', profilesPath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', journal);
  const gate = new ConnectionsService(connections, {} as never);
  const secrets = new Map<string, { value: string; version: string; managed: boolean }>();
  const providers = new Map<
    string,
    {
      name: string;
      id: string;
      type: 'mitzo-openai-keychain-spike';
      workspace: string;
      version: string;
    }
  >();
  const validation = vi.fn(async () => {});
  const keychain = {
    create: vi.fn(async (id: string, value: string) => {
      const ref = openAIEnrollmentCredentialReference(id);
      secrets.set(ref.service, { value, version: id, managed: true });
      return ref;
    }),
    read: vi.fn(async (ref: { service: string }) => secrets.get(ref.service)!),
  };
  const gateway = {
    create: vi.fn(async (id: string) => {
      const provider = {
        name: 'mitzo-openai-' + id,
        id: randomUUID(),
        type: 'mitzo-openai-keychain-spike' as const,
        workspace: 'default',
        version: '1',
      };
      providers.set(id, provider);
      return provider;
    }),
    inspect: vi.fn(async (id: string) => providers.get(id)),
  };
  const enrollment = new OpenAIAccountEnrollment({
    store,
    keychain,
    gateway,
    validateKey: validation,
    discoverModels: (value, signal) =>
      discoverOpenAIEnrollmentModels(
        value,
        signal,
        vi.fn(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }] })),
        ),
      ),
    gatewayBinding: 'openshell',
    workspace: 'default',
    existingAccountIds: () =>
      loadAccountProfiles()
        .catalog()
        .map((p) => p.id),
    gate: (work) => gate.withCredentialMutation(work),
  });
  const app = express();
  const sessionId = randomUUID();
  app.use((_req, res, next) => {
    res.locals.authSession = { id: sessionId, expiresAt: Date.now() + 60000 };
    next();
  });
  app.use(
    '/api/connections',
    createConnectionsRouter({
      store: connections,
      service: gate,
      eligibleAccounts: () => loadAccountProfiles().connectionEligibleIds(),
      gateway: 'openshell',
      workspace: 'default',
      legacyProviders: async () => [],
      openAIAccounts: enrollment,
    }),
  );
  const auth = await request(app)
    .post('/api/connections/reauthorize')
    .send({ passphrase: 'correct' });
  const input = {
    csrf: auth.body.csrf,
    requestId: randomUUID(),
    label: 'New Work',
    projectLabel: 'Intended research project',
    apiKey: 'PRIVATE_KEY',
    billingConfirmed: true,
  };
  return {
    directory,
    journal,
    profilesPath,
    legacy,
    store,
    app,
    input,
    enrollment,
    validation,
    keychain,
    gateway,
  };
}

it('publishes a browser-enrolled account into the real selectable catalog only after verification', async () => {
  const f = await fixture();
  const oldBinding = loadAccountProfiles().resolve('old-work', 'gpt-6-luna');
  f.validation.mockImplementationOnce(async () => {
    const pendingId = f.enrollment.list()[0].id;
    expect(
      loadAccountProfiles()
        .catalog()
        .map((account) => account.id),
    ).toEqual(['old-work']);
    expect(() => loadAccountProfiles().resolve(pendingId, 'gpt-6-luna')).toThrow(
      'Account is unavailable',
    );
  });
  const response = await request(f.app).post('/api/connections/openai-accounts').send(f.input);
  expect(response.status).toBe(201);
  expect(response.body.account.state).toBe('ready');
  const id = response.body.account.id;
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve(id, 'gpt-6-luna');
  expect(profiles.isEnrolledOpenAIAccount(id)).toBe(true);
  expect(profiles.isEnrolledOpenAIAccount('old-work')).toBe(false);
  expect(profiles.catalog().find((account) => account.id === id)).toMatchObject({
    label: 'New Work',
    billing: 'openai-api',
  });
  expect(
    profiles
      .catalog()
      .find((account) => account.id === id)
      ?.models.map((model) => model.id),
  ).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
  const solBinding = profiles.resolve(id, 'gpt-6.1-sol');
  expect(solBinding).toMatchObject({ accountId: id, provider: 'openai', model: 'gpt-6.1-sol' });
  expect(() => profiles.validateModelSelection(solBinding, 'gpt-6.1-sol', 'medium')).not.toThrow();
  expect(profiles.apiProfile(binding).sandboxProvider).toMatch(/^mitzo-openai-/);
  expect(profiles.resume(oldBinding)).toEqual(oldBinding);
  expect(await f.enrollment.resolveKey(id, AbortSignal.timeout(1000))).toBe('PRIVATE_KEY');
  expect(isPrivateCodexPath(f.journal)).toBe(true);
  expect(isPrivateCodexPath(f.journal + '-wal')).toBe(true);
  const publicState = await request(f.app).get('/api/connections/openai-accounts');
  expect(
    JSON.stringify({
      response: response.body,
      publicState: publicState.body,
      catalog: profiles.catalog(),
    }),
  ).not.toMatch(/PRIVATE_KEY|credentialRef|sandboxProvider/);
});
it.each(['validation', 'provider'] as const)(
  'keeps %s failures out of the real account catalog and avoids duplicate enrollment',
  async (boundary) => {
    const f = await fixture();
    if (boundary === 'validation') f.validation.mockRejectedValueOnce(new Error('PRIVATE_KEY'));
    else f.gateway.create.mockRejectedValueOnce(new Error('PRIVATE_KEY'));
    const first = await request(f.app).post('/api/connections/openai-accounts').send(f.input);
    expect(first.body.account.state).toBe(boundary === 'validation' ? 'failed' : 'needs_attention');
    expect(() => loadAccountProfiles().resolve(first.body.account.id, 'gpt-6-luna')).toThrow(
      'Account is unavailable',
    );
    await request(f.app).post('/api/connections/openai-accounts').send(f.input);
    expect(f.validation).toHaveBeenCalledOnce();
    expect(f.gateway.create).toHaveBeenCalledTimes(boundary === 'validation' ? 0 : 1);
  },
);
it('rejects static profile aliases of resources retained by an enrolled account', async () => {
  const f = await fixture();
  await request(f.app).post('/api/connections/openai-accounts').send(f.input);
  const enrolled = f.store.readyProfiles()[0];
  writeFileSync(
    f.profilesPath,
    JSON.stringify([f.legacy, { ...enrolled, id: 'borrowed-static-alias' }]),
  );
  expect(() => loadAccountProfiles()).toThrow('Cannot load account profiles');
});
it('keeps retained enrollment authority active with browser enrollment disabled and admits unrelated legacy accounts', async () => {
  const f = await fixture();
  f.gateway.create.mockRejectedValueOnce(new Error('uncertain provider write'));
  await request(f.app).post('/api/connections/openai-accounts').send(f.input);
  const retainedId = f.enrollment.list()[0].id;
  const runtime = createConnectionsRuntime({
    directory: join(f.directory, 'runtime'),
    cli: 'not-executed',
    workspace: 'default',
    eligibleAccountIds: () => [],
    openAIKeyAccounts: () => [],
    openAIEnrollmentDatabase: f.journal,
    openAIAccountEnrollmentEnabled: false,
  });
  cleanup.push(() => {
    runtime.closeOpenAIKeyManagement?.();
    runtime.store.close();
  });
  expect(runtime.openAIAccounts).toBeUndefined();
  expect(runtime.openAIEnrollmentAuthority?.manages(retainedId)).toBe(true);
  await expect(
    runtime.service.withAccountRuntimes('old-work', async () => 'admitted'),
  ).resolves.toBe('admitted');
  await expect(
    runtime.service.withAccountRuntimes('personal', async () => 'admitted'),
  ).resolves.toBe('admitted');
  await expect(
    runtime.service.withAccountRuntimes(retainedId, async () => 'admitted'),
  ).rejects.toThrow('needs attention');
});
