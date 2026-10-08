import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  OpenAIAccountEnrollment,
  OpenAIAccountEnrollmentStore,
  readReadyOpenAIAccountProfiles,
} from '../openai-account-enrollment.js';
import { openAIEnrollmentCredentialReference } from '../openai-account-enrollment-keychain.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openai-enrollment-'));
  const path = join(root, 'accounts.db');
  const store = new OpenAIAccountEnrollmentStore(path);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
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
  const keychain = {
    create: vi.fn(async (id: string, value: string) => {
      const ref = openAIEnrollmentCredentialReference(id);
      secrets.set(ref.service, { value, version: id, managed: true });
      return ref;
    }),
    read: vi.fn(async (ref: { service: string }) => secrets.get(ref.service)!),
  };
  const gateway = {
    create: vi.fn(async (id: string, _value: string) => {
      const provider = {
        name: 'mitzo-openai-' + id,
        id: 'physical-' + id,
        type: 'mitzo-openai-keychain-spike' as const,
        workspace: 'default',
        version: '1',
      };
      providers.set(id, provider);
      return provider;
    }),
    inspect: vi.fn(async (id: string) => providers.get(id)),
  };
  const validateKey = vi.fn(async () => {});
  const options = {
    store,
    gateway,
    keychain,
    validateKey,
    existingAccountIds: () => ['work'],
    gate: async <T>(work: () => Promise<T>) => work(),
    gatewayBinding: 'https://gateway.invalid',
    workspace: 'default',
  };
  const service = new OpenAIAccountEnrollment(options);
  const input = {
    requestId: randomUUID(),
    label: 'Work replacement',
    projectLabel: 'New work project',
    apiKey: 'sk-secret',
    billingConfirmed: true as const,
  };
  return {
    service,
    options,
    store,
    path,
    input,
    keychain,
    gateway,
    validateKey,
    secrets,
    providers,
  };
}
it('publishes only a verified fresh Luna account and never stores its key', async () => {
  const f = fixture();
  expect(f.store.readyProfiles()).toEqual([]);
  const account = await f.service.enroll(f.input, AbortSignal.timeout(1000));
  expect(account).toMatchObject({
    label: f.input.label,
    projectLabel: f.input.projectLabel,
    state: 'ready',
  });
  expect(account.id).not.toBe('work');
  expect(f.store.readyProfiles()).toEqual([
    expect.objectContaining({
      id: account.id,
      provider: 'openai',
      label: f.input.label,
      models: [
        {
          id: 'gpt-6-luna',
          label: 'Luna 6',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      ],
    }),
  ]);
  expect(await f.service.resolveKey(account.id, AbortSignal.timeout(1000))).toBe('sk-secret');
  expect(f.service.manages(account.id)).toBe(true);
  expect(f.service.manages('work')).toBe(false);
  expect(JSON.stringify(f.service.list())).not.toContain('sk-secret');
  expect(readFileSync(f.path).includes(Buffer.from('sk-secret'))).toBe(false);
  expect(readFileSync(f.path + '-wal').includes(Buffer.from('sk-secret'))).toBe(false);
});
it('reserves intent before validation and replays the same browser request without another charge', async () => {
  const f = fixture();
  f.validateKey.mockImplementationOnce(async () => {
    expect(f.service.list()).toHaveLength(1);
    expect(f.store.readyProfiles()).toEqual([]);
  });
  const first = await f.service.enroll(f.input, AbortSignal.timeout(1000));
  expect(
    await f.service.enroll({ ...f.input, apiKey: 'different-secret' }, AbortSignal.timeout(1000)),
  ).toEqual(first);
  expect(f.validateKey).toHaveBeenCalledOnce();
  expect(f.keychain.create).toHaveBeenCalledOnce();
  expect(f.gateway.create).toHaveBeenCalledOnce();
  await expect(
    f.service.enroll({ ...f.input, projectLabel: 'Different project' }, AbortSignal.timeout(1000)),
  ).rejects.toThrow('Enrollment request changed');
});
it.each(['keychain', 'provider'] as const)(
  'preserves an uncertain %s operation without publishing or blindly retrying',
  async (boundary) => {
    const f = fixture();
    const failure = new Error('Bearer sk-secret PRIVATE_COMMAND');
    if (boundary === 'keychain') f.keychain.create.mockRejectedValueOnce(failure);
    else
      f.gateway.create.mockImplementationOnce(async () => {
        throw failure;
      });
    const status = await f.service.enroll(f.input, AbortSignal.timeout(1000));
    expect(status.state).toBe('needs_attention');
    expect(f.store.readyProfiles()).toEqual([]);
    expect(await f.service.enroll(f.input, AbortSignal.timeout(1000))).toEqual(status);
    expect(f.validateKey).toHaveBeenCalledOnce();
    expect(f.keychain.create).toHaveBeenCalledOnce();
    expect(f.gateway.create).toHaveBeenCalledTimes(boundary === 'provider' ? 1 : 0);
    expect(JSON.stringify(f.service.list())).not.toMatch(/sk-secret|PRIVATE_COMMAND/);
  },
);
it('keeps failed validation private without creating any resources', async () => {
  const f = fixture();
  f.validateKey.mockRejectedValueOnce(new Error('sk-secret'));
  expect((await f.service.enroll(f.input, AbortSignal.timeout(1000))).state).toBe('failed');
  expect(f.keychain.create).not.toHaveBeenCalled();
  expect(f.gateway.create).not.toHaveBeenCalled();
  expect(f.store.readyProfiles()).toEqual([]);
});
it.each(['keychain', 'provider'] as const)(
  'fences an enrolled account after immutable %s drift',
  async (boundary) => {
    const f = fixture();
    const account = await f.service.enroll(f.input, AbortSignal.timeout(1000));
    if (boundary === 'keychain')
      f.keychain.read.mockResolvedValue({ value: 'other', version: randomUUID(), managed: true });
    else f.gateway.inspect.mockResolvedValue(undefined);
    await expect(f.service.assertReady(account.id, AbortSignal.timeout(1000))).rejects.toThrow(
      'OpenAI enrolled account needs attention',
    );
    await expect(f.service.resolveKey(account.id, AbortSignal.timeout(1000))).rejects.toThrow(
      'OpenAI enrolled account needs attention',
    );
    expect(f.gateway.create).toHaveBeenCalledOnce();
  },
);
it('rejects missing billing acknowledgment before validation or persistence', async () => {
  const f = fixture();
  await expect(
    f.service.enroll(
      { ...f.input, billingConfirmed: false as unknown as true },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Invalid OpenAI enrollment request');
  expect(f.validateKey).not.toHaveBeenCalled();
  expect(f.service.list()).toEqual([]);
});

it('reads only published rows without creating a missing configured journal', () => {
  const f = fixture();
  expect(readReadyOpenAIAccountProfiles(f.path)).toEqual([]);
  const missing = f.path + '.missing';
  expect(() => readReadyOpenAIAccountProfiles(missing)).toThrow();
  expect(existsSync(missing)).toBe(false);
});
it('pins the controller gateway and workspace across restarts', async () => {
  const f = fixture();
  const account = await f.service.enroll(f.input, AbortSignal.timeout(1000));
  const changed = new OpenAIAccountEnrollment({
    ...f.options,
    gatewayBinding: 'https://other.invalid',
  });
  await expect(changed.assertReady(account.id, AbortSignal.timeout(1000))).rejects.toThrow(
    'OpenAI enrolled account needs attention',
  );
});
it('rejects account aliases borrowing fresh or retained enrollment resources', async () => {
  const f = fixture();
  await f.service.enroll(f.input, AbortSignal.timeout(1000));
  const profile = f.store.readyProfiles()[0];
  expect(() => f.service.assertResourceOwnership({ ...profile, id: 'alias' })).toThrow(
    'OpenAI enrollment resource belongs to another account',
  );
  expect(() => f.service.assertResourceOwnership(profile)).not.toThrow();
});

it('blocks static aliases of all retained coordinates and duplicate account IDs', async () => {
  const f = fixture();
  await f.service.enroll(f.input, AbortSignal.timeout(1000));
  const profile = f.store.readyProfiles()[0];
  for (const alias of [
    { id: profile.id },
    { id: 'alias', credentialRef: profile.credentialRef },
    { id: 'alias', sandboxProvider: profile.sandboxProvider },
    { id: 'alias', sandboxProviderId: profile.sandboxProviderId },
  ])
    expect(() => readReadyOpenAIAccountProfiles(f.path, [alias])).toThrow(
      'OpenAI enrollment registry unavailable or conflicting',
    );
  const reserved = f.store.reserve(
    {
      requestId: randomUUID(),
      label: 'Interrupted',
      projectLabel: 'Work',
      controllerBinding: 'a'.repeat(64),
    },
    [],
  ).row;
  expect(() =>
    readReadyOpenAIAccountProfiles(f.path, [
      { id: 'alias', credentialRef: openAIEnrollmentCredentialReference(reserved.operationId) },
    ]),
  ).toThrow();
});
it('marks interrupted startup intents as attention-only without replaying a billable test or writes', () => {
  const f = fixture();
  f.store.reserve(
    {
      requestId: f.input.requestId,
      label: f.input.label,
      projectLabel: f.input.projectLabel,
      controllerBinding: 'a'.repeat(64),
    },
    [],
  );
  f.store.recoverInterrupted();
  expect(f.service.list()).toEqual([
    expect.objectContaining({ requestId: f.input.requestId, state: 'needs_attention' }),
  ]);
  expect(f.store.readyProfiles()).toEqual([]);
  expect(f.validateKey).not.toHaveBeenCalled();
  expect(f.keychain.create).not.toHaveBeenCalled();
  expect(f.gateway.create).not.toHaveBeenCalled();
});

it('persists only the approved discovered account catalog before publishing', async () => {
  const f = fixture();
  const models = [
    {
      id: 'gpt-6-luna',
      label: 'Luna 6',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'gpt-6.1-sol',
      label: 'Sol 6.1',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
  ];
  const discoverModels = vi.fn(async () => models);
  const service = new OpenAIAccountEnrollment({ ...f.options, discoverModels });
  const account = await service.enroll(f.input, AbortSignal.timeout(1000));
  expect(account.state).toBe('ready');
  expect(f.store.readyProfiles()[0].models).toEqual(models);
  expect(readReadyOpenAIAccountProfiles(f.path)[0].models).toEqual(models);
  expect(discoverModels).toHaveBeenCalledOnce();
  expect(f.validateKey).toHaveBeenCalledOnce();
});
it('refuses failed model discovery before credential or provider writes', async () => {
  const f = fixture();
  const discoverModels = vi.fn(async () => {
    throw new Error('Bearer sk-secret');
  });
  const service = new OpenAIAccountEnrollment({ ...f.options, discoverModels });
  expect((await service.enroll(f.input, AbortSignal.timeout(1000))).state).toBe('failed');
  expect(f.keychain.create).not.toHaveBeenCalled();
  expect(f.gateway.create).not.toHaveBeenCalled();
  expect(f.store.readyProfiles()).toEqual([]);
  expect(JSON.stringify(service.list())).not.toContain('sk-secret');
});

it('rejects unreviewed discovered metadata before any resource write', async () => {
  const f = fixture();
  const service = new OpenAIAccountEnrollment({
    ...f.options,
    discoverModels: async () => [{ id: 'unreviewed-private-model', label: 'sk-secret' }],
  });
  expect((await service.enroll(f.input, AbortSignal.timeout(1000))).state).toBe('failed');
  expect(f.keychain.create).not.toHaveBeenCalled();
  expect(f.gateway.create).not.toHaveBeenCalled();
  expect(readFileSync(f.path + '-wal').includes(Buffer.from('sk-secret'))).toBe(false);
});

it('accepts the same 120-character labels as the browser and router', async () => {
  const f = fixture();
  const input = { ...f.input, label: 'L'.repeat(120), projectLabel: 'P'.repeat(120) };
  expect(await f.service.enroll(input, AbortSignal.timeout(1000))).toMatchObject({
    label: input.label,
    projectLabel: input.projectLabel,
    state: 'ready',
  });
  await expect(
    f.service.enroll(
      { ...input, requestId: randomUUID(), label: 'L'.repeat(121) },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('Invalid OpenAI enrollment request');
});
