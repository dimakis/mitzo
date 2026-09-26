import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
import type { SubscriptionProvisioningHost } from '../symposium-subscription-provisioner.js';
const mocked = vi.hoisted(() => ({
  host: undefined as SubscriptionProvisioningHost | undefined,
  finish: undefined as ((value: unknown) => void) | undefined,
  fail: undefined as ((error: Error) => void) | undefined,
}));
vi.mock('../symposium-subscription-provisioner.js', () => ({
  SymposiumSubscriptionProvisioner: class {
    constructor(host: SubscriptionProvisioningHost) {
      mocked.host = host;
    }
    invalidate = vi.fn();
    verifyPrivateAuth = vi.fn();
    assertPrivateAuth = vi.fn();
  },
  attendSubscriptionLogin: async () => ({
    authorizationUrl: 'https://auth.openai.com/test',
    completed: new Promise((resolve, reject) => {
      mocked.finish = resolve;
      mocked.fail = reject;
    }),
    cancel() {
      mocked.fail!(new Error('cancelled'));
    },
  }),
}));
import { createSymposiumSubscriptionHost } from '../symposium-subscription-host.js';
function fixture() {
  const gateway = {
    gateway: 'owned',
    workspace: 'workspace',
    cli: '/private/openshell',
    managementEnvironment: {
      HOME: '/private/home',
      XDG_CONFIG_HOME: '/private/config',
      PATH: '/usr/bin',
    },
    verifyCustody: vi.fn(),
  };
  const run = vi.fn().mockReturnValue({ status: 0, stdout: 'Created provider' });
  const options = {
    gateway: gateway as unknown as OwnedSymposiumGateway,
    seatProof: { assertCurrent: vi.fn(), verify: vi.fn().mockResolvedValue(undefined) },
    workProfiles: [],
    accountId: 'personal',
    label: 'Personal',
    selectedModel: 'gpt-5.6-luna',
    models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
  };
  return { gateway, run, options };
}
beforeEach(() => {
  mocked.host = undefined;
  mocked.finish = undefined;
  mocked.fail = undefined;
});
describe('subscription host adapter', () => {
  it('has no personal catalog before completed authorization; exact selection is preserved', async () => {
    const f = fixture();
    const adapter = createSymposiumSubscriptionHost(f.options, f.run);
    expect(adapter.currentProfiles.catalog()).toEqual([]);
    const login = await adapter.beginLogin();
    const binding = await mocked.host!.installProfile({
      subject: 's',
      accountId: 'real-account',
      email: 'e',
      planType: 'pro',
      provider: 'new-provider',
      providerId: 'provider-id',
    });
    expect(binding.model).toBe('gpt-5.6-luna');
    expect(adapter.currentProfiles.catalog()).toEqual([]);
    mocked.finish!({ binding });
    await login.completed;
    expect(adapter.currentProfiles.resolve('personal', 'gpt-5.6-luna')).toEqual(binding);
    expect(() => adapter.currentProfiles.resolve('personal', 'other-model')).toThrow();
    adapter.invalidate();
    expect(adapter.currentProfiles.catalog()).toEqual([]);
  });
  it('authorizes another configured model without admitting a missing model', async () => {
    const f = fixture();
    f.options.models.push({ id: 'another-configured-model', label: 'Another' });
    const adapter = createSymposiumSubscriptionHost(f.options, f.run);
    const login = await adapter.beginLogin();
    const binding = await mocked.host!.installProfile({
      subject: 's',
      accountId: 'real-account',
      email: 'e',
      planType: 'pro',
      provider: 'new-provider',
      providerId: 'provider-id',
    });
    mocked.finish!({ binding });
    await login.completed;
    const selected = adapter.currentProfiles.resolve('personal', 'another-configured-model');
    const input = {
      execution: { seat: { accountBinding: selected } },
      route: {
        kind: 'chatgpt-subscription-native',
        model: selected.model,
        profile: { model: selected.model },
      },
    } as Parameters<typeof adapter.assertPrivateAuth>[0];
    expect(() => adapter.assertPrivateAuth(input)).not.toThrow();
    selected.model = 'missing-model';
    input.route.model = selected.model;
    if (input.route.kind !== 'chatgpt-subscription-native')
      throw new Error('Unexpected test route');
    input.route.profile.model = selected.model;
    expect(() => adapter.assertPrivateAuth(input)).toThrow();
  });
  it('does not publish a staged profile when login is cancelled or fails', async () => {
    const f = fixture();
    const adapter = createSymposiumSubscriptionHost(f.options, f.run);
    const login = await adapter.beginLogin();
    await mocked.host!.installProfile({
      subject: 's',
      accountId: 'real-account',
      email: 'e',
      planType: 'pro',
      provider: 'new-provider',
      providerId: 'provider-id',
    });
    login.cancel();
    await expect(login.completed).rejects.toThrow('did not complete');
    expect(adapter.currentProfiles.catalog()).toEqual([]);
  });
  it('pins gateway/private environment and never puts secrets in arguments or errors', async () => {
    const f = fixture();
    createSymposiumSubscriptionHost(f.options, f.run);
    await mocked.host!.run(['provider', 'create', '--name', 'new'], {
      CODEX_AUTH_ACCESS_TOKEN: 'fake-secret',
    });
    expect(f.run.mock.calls[0][0]).toBe('/private/openshell');
    expect(f.run.mock.calls[0][1]).toEqual([
      'provider',
      '--gateway',
      'owned',
      '--workspace',
      'workspace',
      'create',
      '--name',
      'new',
    ]);
    expect(f.run.mock.calls[0][2].env.CODEX_AUTH_ACCESS_TOKEN).toBe('fake-secret');
    expect(JSON.stringify(f.run.mock.calls[0][1])).not.toContain('fake-secret');
    f.run.mockReturnValue({ status: 1, stdout: 'fake-secret', stderr: 'fake-secret' });
    await expect(mocked.host!.run(['provider', 'create'])).rejects.toThrow(
      'management operation failed',
    );
  });
  it('rejects missing selected model and unsafe inherited environment', () => {
    const f = fixture();
    expect(() => createSymposiumSubscriptionHost({ ...f.options, models: [] }, f.run)).toThrow(
      'explicit available',
    );
    f.gateway.managementEnvironment = {
      ...f.gateway.managementEnvironment,
      NODE_OPTIONS: 'unsafe',
    } as typeof f.gateway.managementEnvironment;
    expect(() => createSymposiumSubscriptionHost(f.options, f.run)).toThrow(
      'private OpenShell CLI environment',
    );
  });
});
