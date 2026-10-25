import { describe, expect, it } from 'vitest';
import { ordinaryOpenShellCodexTarget } from '../ordinary-openshell-codex-route.js';
import { ordinaryOpenShellCodexContinuationTarget } from '../openshell-chat-continuity.js';
import { openShellPhysicalCustodyFingerprint } from '../openshell-codex-custody.js';
import type { ArtifactRuntime } from '../codex-conversation-store.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';

const config: OpenShellRuntimeConfig = {
  cli: '/offline/openshell',
  image: 'image-a',
  policy: '/releases/a/policy',
  seed: '/releases/a/seed',
  workspace: 'work',
  gateway: 'gateway',
  gatewayEndpoint: 'https://gateway.test',
  gatewayInsecure: false,
  workdir: '/sandbox/workspaces/task',
  serviceProviders: [],
  grantableServiceProviders: [],
  createDetached: true,
  sandboxIdLength: 13,
  webSearch: 'disabled',
};
const target = (runtimeContractRevision = 'release-a', selected = config) =>
  ordinaryOpenShellCodexTarget({
    targetId: 'sandbox',
    runtimeContractRevision,
    config: selected,
    openaiApi: 'enabled',
  });
function fixture() {
  const account = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai' as const,
    profileRevision: 'account-r1',
    model: 'offline',
  };
  const binding = {
    version: 2 as const,
    account: {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: {
      location: 'openshell' as const,
      targetId: 'sandbox',
      targetRevision: 'legacy-release-fingerprint',
    },
  };
  const artifact: ArtifactRuntime = {
    route: { kind: 'api', provider: 'work-provider', model: 'offline' },
    runtime: {
      sandboxName: 'original-sandbox',
      sandboxId: 'original-physical-id',
      cli: config.cli,
      workspace: config.workspace,
      gateway: config.gateway,
      gatewayEndpoint: config.gatewayEndpoint,
      gatewayInsecure: config.gatewayInsecure,
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-app-server',
    },
  };
  const custody = {
    version: 1 as const,
    authSessionId: 'original-login',
    binding,
    workspace: { workspaceId: 'repo', cwd: config.workdir },
    physicalIdentitySha256: openShellPhysicalCustodyFingerprint(artifact),
  };
  return {
    account,
    binding,
    artifact,
    custody,
    target: target('release-b'),
    config,
    authSessionId: 'original-login',
  };
}
describe('OpenShell chat continuity across upgrades (offline)', () => {
  it('keeps the chat target stable when deployed code, release paths, image or seed changes', () => {
    expect(
      target('release-b', {
        ...config,
        image: 'image-b',
        policy: '/releases/b/policy',
        seed: '/releases/b/seed',
        seedStackManifest: { revision: 'b' },
      }),
    ).toEqual(target());
  });
  it.each(['gateway', 'workspace', 'gatewayEndpoint', 'workdir', 'cli'] as const)(
    'separates a different %s namespace',
    (key) => {
      expect(target('release-a', { ...config, [key]: 'different' })).not.toEqual(target());
    },
  );
  it('qualifies a legacy saved binding from exact native custody without rewriting its history', () => {
    const f = fixture();
    const before = structuredClone(f);
    expect(ordinaryOpenShellCodexContinuationTarget(f)).toEqual({
      ...f.target,
      targetRevision: f.binding.execution.targetRevision,
    });
    expect(f).toEqual(before);
  });
  it.each([
    'login',
    'account',
    'target',
    'custody',
    'physical',
    'gateway',
    'workspace',
    'cli-environment',
  ] as const)('refuses changed %s authority', (change) => {
    const f = fixture();
    if (change === 'login') f.authSessionId = 'other-login';
    if (change === 'account') f.account.profileRevision = 'other-account';
    if (change === 'target') f.target.targetId = 'other-target';
    if (change === 'custody')
      f.custody.binding = {
        ...f.binding,
        execution: { ...f.binding.execution, targetRevision: 'foreign' },
      };
    if (change === 'physical') f.artifact.runtime.sandboxId = 'replacement-sandbox';
    if (change === 'gateway') f.config = { ...config, gateway: 'other-gateway' };
    if (change === 'workspace') f.config = { ...config, workdir: '/different' };
    if (change === 'cli-environment')
      f.config = {
        ...config,
        cliEnvironment: { HOME: '/other', XDG_CONFIG_HOME: '/other/config', PATH: '/bin' },
      };
    expect(() => ordinaryOpenShellCodexContinuationTarget(f)).toThrow();
  });
});

it('keeps current deployment attestation sensitive to code, seed paths and policy changes', async () => {
  const { ordinaryOpenShellCodexDeploymentRevision } =
    await import('../ordinary-openshell-codex-route.js');
  const declaration = {
    targetId: 'sandbox',
    runtimeContractRevision: 'release-a',
    config,
    openaiApi: 'enabled' as const,
  };
  const original = ordinaryOpenShellCodexDeploymentRevision(declaration);
  expect(
    ordinaryOpenShellCodexDeploymentRevision({
      ...declaration,
      runtimeContractRevision: 'release-b',
    }),
  ).not.toBe(original);
  expect(
    ordinaryOpenShellCodexDeploymentRevision({
      ...declaration,
      config: { ...config, policy: '/releases/b/policy' },
    }),
  ).not.toBe(original);
});
