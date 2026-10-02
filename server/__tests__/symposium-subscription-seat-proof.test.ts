import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createSymposiumSubscriptionSeatProof } from '../symposium-subscription-seat-proof.js';
import { sandboxNameForConversation } from '../openshell-runtime.js';
import { admitSymposiumSeatDispatch } from '../symposium-seat-runtime.js';
import { snapshotSymposiumSeatProvider } from '../symposium-session-runtime.js';
vi.mock('../symposium-seat-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  admitSymposiumSeatDispatch: vi.fn(),
}));
vi.mock('../symposium-session-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  snapshotSymposiumSeatProvider: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const runtimeId = 'symposium-seat:fixture';
  const name = sandboxNameForConversation(runtimeId);
  const route = {
    kind: 'chatgpt-subscription-native',
    provider: 'personal-native',
    providerId: 'provider-id',
    model: 'luna',
    accountId: 'personal',
  };
  const env = { HOME: '/private/home', XDG_CONFIG_HOME: '/private/config', PATH: '/usr/bin:/bin' };
  const config = {
    cli: '/bin/openshell',
    gateway: 'owned',
    workspace: 'workspace',
    gatewayEndpoint: 'https://127.0.0.1:7777',
    gatewayInsecure: false,
    cliEnvironment: env,
    cliContract: 'v0.1',
    workdir: '/sandbox/workspaces/mgmt',
  };
  const input = {
    route,
    sandbox: { ...config, sandboxName: name, sandboxId: 'physical-id' },
    execution: {
      sessionId: 'session',
      seat: { id: 'seat' },
      provenance: { membershipGeneration: 2 },
      signal: new AbortController().signal,
    },
  };
  const record = {
    sessionId: 'session',
    seatId: 'seat',
    generation: 2,
    runtimeId,
    workspace: 'workspace',
    providerName: 'personal-native',
    providerId: 'provider-id',
    providerType: 'codex',
    model: 'luna',
    sandboxName: name,
    physicalId: 'physical-id',
    creationStarted: true,
    creationCompleted: true,
    state: 'ready',
  };
  const publicSandbox = {
    id: 'physical-id',
    name,
    workspace: 'workspace',
    phase: 'Ready',
    labels: {
      'mitzo.conversation': createHash('sha256').update(runtimeId).digest('hex').slice(0, 63),
    },
  };
  const attachments = {
    providers: [{ name: 'personal-native', type: 'codex' }],
    next_page_token: '',
  };
  const verify = vi.fn();
  vi.mocked(admitSymposiumSeatDispatch).mockReturnValue(route as never);
  vi.mocked(snapshotSymposiumSeatProvider).mockReturnValue({
    runtimeId,
    generation: 2,
    verify,
  } as never);
  const run = vi.fn((_exe, args: string[]) => ({
    status: 0,
    stdout: JSON.stringify(args.includes('get') ? publicSandbox : attachments),
  }));
  const custody = vi.fn();
  const registry = { getSymposiumSeatSandbox: vi.fn(() => record) };
  const proof = createSymposiumSubscriptionSeatProof(
    {
      facts: {} as never,
      currentProfiles: () => ({}) as never,
      hostGrants: { verifySeat: vi.fn() },
      registry: registry as never,
      runtimeConfig: config as never,
      verifyGatewayCustody: custody,
    },
    run as never,
  );
  return {
    input: input as unknown as Parameters<typeof proof.assertCurrent>[0],
    record,
    publicSandbox,
    attachments,
    proof,
    run,
    custody,
    verify,
    registry,
  };
}
describe('subscription seat authorization composition', () => {
  it('checks host admission, current registry, exact public sandbox and attachment', async () => {
    const f = fixture();
    await f.proof.verify(f.input);
    expect(admitSymposiumSeatDispatch).toHaveBeenCalledTimes(2);
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.custody).toHaveBeenCalled();
    expect(
      f.run.mock.calls.every(
        ([, args]) => args.includes('--gateway-endpoint') && args.includes('workspace'),
      ),
    ).toBe(true);
  });
  it('rejects wrong carried or public physical ID', () => {
    const f = fixture();
    (f.input.sandbox as { sandboxId?: string }).sandboxId = 'other';
    expect(() => f.proof.assertCurrent(f.input)).toThrow('physical sandbox ID');
    (f.input.sandbox as { sandboxId?: string }).sandboxId = 'physical-id';
    f.publicSandbox.id = 'other';
    expect(() => f.proof.assertCurrent(f.input)).toThrow('physical sandbox identity');
  });
  it('rejects another seat provider and extra attachments', () => {
    const f = fixture();
    f.attachments.providers[0].name = 'other';
    expect(() => f.proof.assertCurrent(f.input)).toThrow('attachment');
    f.attachments.providers = [
      { name: 'personal-native', type: 'codex' },
      { name: 'work', type: 'openai' },
    ];
    expect(() => f.proof.assertCurrent(f.input)).toThrow('attachment');
  });
  it('fails closed on stale membership, stale profile and registry generation', () => {
    const f = fixture();
    vi.mocked(admitSymposiumSeatDispatch).mockImplementation(() => {
      throw Error('membership is stale');
    });
    expect(() => f.proof.assertCurrent(f.input)).toThrow('membership');
    expect(f.run).not.toHaveBeenCalled();
    vi.mocked(admitSymposiumSeatDispatch).mockReturnValue({ ...f.input.route, model: 'changed' });
    expect(() => f.proof.assertCurrent(f.input)).toThrow('profile');
    vi.mocked(admitSymposiumSeatDispatch).mockReturnValue(f.input.route);
    f.record.generation = 3;
    expect(() => f.proof.assertCurrent(f.input)).toThrow('registry');
  });
  it('rejects route mismatch before any gateway reads', () => {
    const f = fixture();
    f.input.sandbox.gateway = 'legacy';
    expect(() => f.proof.assertCurrent(f.input)).toThrow('gateway route');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('rechecks registry and admission after public reads', () => {
    const f = fixture();
    f.verify.mockImplementation(() => {
      f.registry.getSymposiumSeatSandbox.mockReturnValue({ ...f.record, state: 'stopped' });
    });
    expect(() => f.proof.assertCurrent(f.input)).toThrow('during proof');
  });
});
