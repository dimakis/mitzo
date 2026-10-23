import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { credentials } from '../credentials.js';

const api = {
  id: 'connection-fixture',
  label: 'Work',
  provider: 'openai',
  credentialRef: { provider: 'keychain', service: 'synthetic-connection', account: 'key' },
  models: [{ id: 'luna', label: 'Fixture Luna' }],
};
const connection = {
  endpoint: 'https://gateway.example.test/v1',
  protocol: 'responses',
  qualification: {
    source: 'operator',
    streaming: true,
    toolCalls: true,
    continuation: true,
    cancellation: true,
  },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preserves official defaults and routing identity without reading credentials', () => {
  const resolve = vi.spyOn(credentials, 'resolve');
  const profiles = new AccountProfiles([api]);
  const binding = profiles.resolve(api.id, 'luna');
  expect(binding.profileRevision).toBe(
    createHash('sha256')
      .update(JSON.stringify(['openai', api.credentialRef, undefined, undefined]))
      .digest('hex'),
  );
  expect(profiles.harnessConnection(binding)).toEqual({
    harness: 'codex',
    authentication: 'api-key',
    endpoint: 'https://api.openai.com/v1',
    protocol: 'responses',
    qualification: 'official',
    capabilities: { streaming: true, toolCalls: true, continuation: true, cancellation: true },
  });
  expect(resolve).not.toHaveBeenCalled();
});

it('projects operator-qualified Responses configuration independently of target and credentials', async () => {
  const resolve = vi.spyOn(credentials, 'resolve');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const profiles = new AccountProfiles([{ ...api, connection }], { codexEnabled: true });
  const binding = profiles.resolve(api.id, 'luna');
  expect(profiles.harnessConnection(binding)).toMatchObject({
    harness: 'codex',
    authentication: 'api-key',
    endpoint: connection.endpoint,
    qualification: 'operator',
    capabilities: { streaming: true, toolCalls: true, continuation: true, cancellation: true },
  });
  expect(JSON.stringify(profiles.harnessConnection(binding))).not.toContain('synthetic-connection');
  await profiles.refresh(true);
  expect(profiles.catalog()[0].models).toEqual(api.models);
  expect(resolve).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(profiles.ordinaryLocalCodexInventory()[0].account.profileRevision).toBe(
    binding.profileRevision,
  );
  expect(() => profiles.apiCredential(binding)).toThrow(/shared Codex|custom endpoint/i);
});

it.each([
  { protocol: 'chat-completions' },
  { protocol: 'messages' },
  { qualification: undefined },
  ...['streaming', 'toolCalls', 'continuation', 'cancellation'].map((capability) => ({
    qualification: { ...connection.qualification, [capability]: false },
  })),
])('fails unsupported capability before reading a credential: %j', (change) => {
  const resolve = vi.spyOn(credentials, 'resolve');
  const profiles = new AccountProfiles([{ ...api, connection: { ...connection, ...change } }]);
  const binding = profiles.resolve(api.id, 'luna');
  expect(() => profiles.harnessConnection(binding)).toThrow(/Responses|qualification|capability/i);
  expect(resolve).not.toHaveBeenCalled();
});

it.each([
  'http://gateway.example.test/v1',
  'https://user:password@gateway.example.test/v1',
  'https://gateway.example.test/v1?secret=x',
  'https://gateway.example.test/v1#secret',
  'file:///tmp/socket',
  'not a URL',
])('rejects unsafe endpoint configuration %s', (endpoint) => {
  expect(() => new AccountProfiles([{ ...api, connection: { ...connection, endpoint } }])).toThrow(
    /Invalid account profiles/,
  );
});

it('binds route revisions to endpoint, protocol and qualification while retaining historical models', () => {
  const original = new AccountProfiles([{ ...api, connection }]);
  const binding = original.resolve(api.id, 'luna');
  for (const change of [
    { endpoint: 'https://other.example.test/v1' },
    { protocol: 'messages' },
    { qualification: { ...connection.qualification, cancellation: false } },
  ]) {
    expect(() =>
      new AccountProfiles([{ ...api, connection: { ...connection, ...change } }]).resumeRouting(
        binding,
      ),
    ).toThrow(/configuration changed/);
  }
  const changedCatalog = new AccountProfiles([
    { ...api, connection, models: [{ id: 'new', label: 'New' }] },
  ]);
  expect(changedCatalog.resumeRouting(binding)).toEqual(binding);
});

it('never accepts a gateway endpoint for subscription credentials', () => {
  const subscription = {
    id: 'subscription',
    label: 'Personal',
    provider: 'openai-codex',
    credentialRef: '/offline/login',
    email: 'fixture@example.test',
    planType: 'plus',
    models: api.models,
  };
  expect(
    () => new AccountProfiles([{ ...subscription, connection }], { codexEnabled: true }),
  ).toThrow(/Invalid account profiles/);
  const profiles = new AccountProfiles([subscription], { codexEnabled: true });
  expect(profiles.harnessConnection(profiles.resolve(subscription.id, 'luna'))).toMatchObject({
    harness: 'codex',
    authentication: 'chatgpt-subscription',
    qualification: 'official',
  });
});

it('does not advertise a custom endpoint on unqualified legacy or OpenShell routes', () => {
  const profiles = new AccountProfiles(
    [{ ...api, connection, sandboxProvider: 'fixture', sandboxProviderId: 'fixture-id' }],
    { codexEnabled: true },
  );
  expect(profiles.ordinaryLocalCodexInventory()).toHaveLength(1);
  expect(profiles.ordinaryLocalResponsesInventory()).toEqual([]);
  expect(profiles.ordinaryOpenShellCodexInventory('fixture-target', true)).toEqual([]);
  const binding = profiles.resolve(api.id, 'luna');
  expect(() => profiles.apiProfile(binding)).toThrow(/shared Codex/);
  expect(profiles.apiProfile(binding, { allowCustomEndpoint: true }).connection).toEqual(
    connection,
  );
});
it('does not claim tool or streaming capabilities for an unqualified configured endpoint', () => {
  const profiles = new AccountProfiles([
    { ...api, connection: { ...connection, qualification: undefined } },
  ]);
  expect(profiles.catalog()[0].capabilities).toMatchObject({ tools: false, streaming: false });
});
