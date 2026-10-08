import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../connections-gateway.js';
import {
  OpenShellOpenAIEnrollmentGateway,
  OpenAIProviderCreationUnconfirmedError,
} from '../openai-provider-enrollment-gateway.js';

const operationId = '890456d2-8b5d-43d6-b8b8-48c1c99837c0';
const name = `mitzo-openai-${operationId}`;
const signal = () => AbortSignal.timeout(5000);
function fixture() {
  let created = false;
  const profile = load(
    readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  Object.assign(profile, { source: 'user', scope: 'workspace', resource_version: 7 });
  const provider = {
    name,
    id: 'adbac7b3-6d87-4bd4-bb38-3f2c7939bebc',
    workspace: 'default',
    type: 'mitzo-openai-keychain-spike',
    resource_version: 1,
    credential_keys: ['OPENAI_API_KEY'],
    config_keys: [] as string[],
  };
  const run = vi.fn<CommandRunner>(async (args) => {
    if (args.includes('export')) return JSON.stringify(profile);
    if (args.includes('create')) {
      created = true;
      return 'Created provider';
    }
    if (args.includes('list')) return JSON.stringify(created ? [provider] : []);
    throw new Error('Unexpected fixture command');
  });
  return {
    profile,
    provider,
    run,
    gateway: new OpenShellOpenAIEnrollmentGateway(run, 'default'),
    preexisting: () => {
      created = true;
    },
  };
}
describe('fresh OpenAI provider enrollment', () => {
  it('uses reviewed existing profile and environment-only secret ingress without requiring update CAS', async () => {
    const f = fixture();
    expect(f.gateway.providerName(operationId)).toBe(name);
    expect(await f.gateway.create(operationId, 'SYNTHETIC_PRIVATE_KEY', signal())).toEqual({
      name,
      id: f.provider.id,
      workspace: 'default',
      type: f.provider.type,
      version: '1',
    });
    const create = f.run.mock.calls.find(([args]) => args.includes('create'))!;
    expect(create[0]).toEqual([
      'provider',
      'create',
      '--name',
      name,
      '--type',
      'mitzo-openai-keychain-spike',
      '--workspace',
      'default',
      '--credential',
      'OPENAI_API_KEY',
    ]);
    expect(create[1].env).toEqual({ OPENAI_API_KEY: 'SYNTHETIC_PRIVATE_KEY' });
    expect(JSON.stringify(f.run.mock.calls.map(([args]) => args))).not.toContain(
      'SYNTHETIC_PRIVATE_KEY',
    );
    expect(
      f.run.mock.calls.some(
        ([args]) => args.includes('update') || args.includes('delete') || args.includes('attach'),
      ),
    ).toBe(false);
  });
  it('does not overwrite an existing provider or allow a caller-selected name', async () => {
    const f = fixture();
    f.preexisting();
    await expect(f.gateway.create(operationId, 'SYNTHETIC_PRIVATE_KEY', signal())).rejects.toThrow(
      'already exists',
    );
    await expect(
      f.gateway.create('existing-work-provider', 'SYNTHETIC_PRIVATE_KEY', signal()),
    ).rejects.toThrow();
    expect(f.run.mock.calls.some(([args]) => args.includes('create'))).toBe(false);
  });
  it('rejects profile, selector, credential and provider identity drift', async () => {
    for (const mutation of [
      'profile',
      'scope',
      'credential',
      'identity',
      'config',
      'version',
    ] as const) {
      const f = fixture();
      f.preexisting();
      if (mutation === 'profile') (f.profile.binaries as string[]).push('/bin/sh');
      if (mutation === 'scope') f.profile.scope = 'platform';
      if (mutation === 'credential') f.provider.credential_keys.push('OTHER_KEY');
      if (mutation === 'identity') f.provider.id = 'not-a-provider-uuid';
      if (mutation === 'config') f.provider.config_keys.push('unexpected');
      if (mutation === 'version') f.provider.resource_version = 2;
      await expect(f.gateway.inspect(operationId, signal())).rejects.toThrow(
        'OpenAI enrollment provider could not be verified',
      );
    }
  });
  it('surfaces uncertain create without exposing command output or repeating the mutation', async () => {
    const f = fixture();
    f.run.mockImplementationOnce(async () => JSON.stringify(f.profile));
    f.run.mockImplementationOnce(async () => '[]');
    f.run.mockImplementationOnce(async () => {
      throw new Error('SYNTHETIC_PRIVATE_KEY in stderr');
    });
    await expect(f.gateway.create(operationId, 'SYNTHETIC_PRIVATE_KEY', signal())).rejects.toThrow(
      OpenAIProviderCreationUnconfirmedError,
    );
    expect(f.run.mock.calls.filter(([args]) => args.includes('create'))).toHaveLength(1);
  });
  it('allows inspection to reconcile a pending operation without create or credential input', async () => {
    const f = fixture();
    expect(await f.gateway.inspect(operationId, signal())).toBeUndefined();
    f.preexisting();
    expect(await f.gateway.inspect(operationId, signal())).toMatchObject({
      name,
      id: f.provider.id,
      version: '1',
    });
    expect(f.run.mock.calls.every(([, options]) => Object.keys(options.env).length === 0)).toBe(
      true,
    );
    expect(f.run.mock.calls.some(([args]) => args.includes('create'))).toBe(false);
  });
  it('accepts the installed CLI serializer omission for an empty config map', async () => {
    const f = fixture();
    f.preexisting();
    Reflect.deleteProperty(f.provider, 'config_keys');
    expect(await f.gateway.inspect(operationId, signal())).toMatchObject({ id: f.provider.id });
  });
  it('reads every bounded inventory page before claiming absence or confirming identity', async () => {
    const f = fixture();
    f.run.mockImplementation(async (args) => {
      if (args.includes('export')) return JSON.stringify(f.profile);
      const offset = args[args.indexOf('--offset') + 1];
      if (offset === '0')
        return JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ name: `other-${i}` })));
      if (offset === '100') return JSON.stringify([f.provider]);
      throw new Error('Missing pagination');
    });
    expect(await f.gateway.inspect(operationId, signal())).toMatchObject({ id: f.provider.id });
    expect(f.run.mock.calls.filter(([args]) => args.includes('list'))).toHaveLength(2);
  });
});
