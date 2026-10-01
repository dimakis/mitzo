import { it, expect, vi } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import type { OpenShellAccountRoute } from '../openshell-runtime.js';
import {
  createSessionArtifactReader,
  isOpenShellArtifactSession,
  validateSessionArtifactRuntime,
} from '../session-artifact-reader.js';

const binding = {
  accountId: 'account',
  provider: 'openai',
  model: 'model',
  profileRevision: '1',
} as AccountBinding;
const runtime = {
  sandboxId: 'physical',
  sandboxName: 'owned',
  workdir: '/sandbox/workspaces/mgmt',
  cli: '/bin/openshell',
  gateway: 'gateway',
  workspace: 'workspace',
  gatewayInsecure: false,
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
};
const route: OpenShellAccountRoute = { kind: 'api', provider: 'provider', model: 'model' };
function deps() {
  return {
    readRuntime: vi.fn(() => ({ runtime, route })),
    currentRoute: vi.fn(() => route),
    validateRuntime: vi.fn(),
    inspect: vi.fn().mockResolvedValue({ id: 'physical', phase: 'Ready' }),
    read: vi
      .fn()
      .mockImplementation(async (_runtime, _path, _signal, verify: () => Promise<void>) => {
        await verify();
        const result = { path: `${runtime.workdir}/report.md`, bytes: Buffer.from('# Report') };
        await verify();
        return result;
      }),
  };
}
it.each([
  { provider: 'openai', selectedRoute: route },
  {
    provider: 'openai-codex',
    selectedRoute: {
      kind: 'chatgpt-subscription',
      provider: 'provider',
      model: 'model',
      providerType: 'openai-codex-oauth',
      providerId: 'oauth-provider',
      grantId: 'grant',
    } as OpenShellAccountRoute,
  },
  {
    provider: 'openai-codex',
    selectedRoute: {
      kind: 'chatgpt-subscription-native',
      provider: 'provider',
      model: 'model',
      providerType: 'codex',
      providerId: 'native-provider',
    } as OpenShellAccountRoute,
  },
])(
  'reads an inactive $selectedRoute.kind conversation using persisted exact runtime',
  async ({ provider, selectedRoute }) => {
    const d = deps();
    d.readRuntime.mockReturnValue({ runtime, route: selectedRoute });
    d.currentRoute.mockReturnValue(selectedRoute);
    const selected = { ...binding, provider } as AccountBinding;
    const result = await createSessionArtifactReader(d)(
      'old-session',
      selected,
      runtime.workdir,
      'report.md',
    );
    expect(result.bytes.toString()).toBe('# Report');
    expect(d.readRuntime).toHaveBeenCalledWith('old-session', selected);
    expect(d.inspect).toHaveBeenCalledTimes(2);
    expect(d.read).toHaveBeenCalledWith(
      runtime,
      'report.md',
      expect.any(AbortSignal),
      expect.any(Function),
    );
  },
);
it('fails closed when old conversation has no pinned runtime', async () => {
  const d = deps();
  d.readRuntime.mockReturnValue(null as never);
  await expect(
    createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(d.read).not.toHaveBeenCalled();
});
it.each(['Stopped', 'Deleted'])('does not restore a %s workspace on GET', async (phase) => {
  const d = deps();
  d.inspect.mockResolvedValue({ id: 'physical', phase });
  await expect(
    createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
});
it('rejects a replaced sandbox and changed subscription route', async () => {
  const d = deps();
  d.inspect.mockResolvedValue({ id: 'replacement', phase: 'Ready' });
  await expect(
    createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  const e = deps();
  e.currentRoute.mockReturnValue({ ...route, provider: 'other' });
  await expect(
    createSessionArtifactReader(e)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(e.read).not.toHaveBeenCalled();
});
it('rejects workspace mismatch and disappearance after read', async () => {
  const d = deps();
  await expect(
    createSessionArtifactReader(d)('old', binding, '/sandbox/other', 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  const e = deps();
  e.inspect
    .mockResolvedValueOnce({ id: 'physical', phase: 'Ready' })
    .mockResolvedValueOnce(undefined);
  await expect(
    createSessionArtifactReader(e)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
});

it('rejects changed CLI environment authority and accepts matching gateway configuration', () => {
  const current = { ...runtime, cliEnvironment: { HOME: '/trusted/home' } };
  expect(() => validateSessionArtifactRuntime(current, current)).not.toThrow();
  expect(() =>
    validateSessionArtifactRuntime(
      { ...current, cliEnvironment: { HOME: '/other/home' } },
      current,
    ),
  ).toThrow('configuration changed');
  expect(() =>
    validateSessionArtifactRuntime(
      { ...current, gatewayEndpoint: 'https://other-gateway' },
      current,
    ),
  ).toThrow('configuration changed');
});

it('rejects changed subscription provider identity or grant', async () => {
  const subscription = {
    kind: 'chatgpt-subscription',
    provider: 'provider',
    model: 'model',
    providerType: 'openai-codex-oauth',
    providerId: 'provider-id',
    grantId: 'grant',
  } as const;
  for (const change of [
    { providerId: 'replacement' },
    { grantId: 'replacement' },
    { model: 'replacement' },
  ]) {
    const d = deps();
    d.readRuntime.mockReturnValue({ runtime, route: subscription });
    d.currentRoute.mockReturnValue({ ...subscription, ...change });
    await expect(
      createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
    ).rejects.toMatchObject({ status: 409 });
    expect(d.read).not.toHaveBeenCalled();
  }
});

it.each(['google-vertex', 'anthropic-vertex', 'anthropic'])(
  'keeps a %s host workspace under /sandbox local',
  (provider) => {
    expect(
      isOpenShellArtifactSession({ cwd: '/sandbox/host-repository', accountBinding: { provider } }),
    ).toBe(false);
    expect(
      isOpenShellArtifactSession(
        { cwd: '/sandbox/workspaces/mgmt', accountBinding: { provider } },
        '/sandbox/workspaces/mgmt',
      ),
    ).toBe(false);
  },
);

it('does not infer OpenShell authority from an unbound /sandbox host cwd', () => {
  expect(isOpenShellArtifactSession({ cwd: '/sandbox/host-repository' })).toBe(false);
});

it.each(['openai', 'openai-codex'])(
  'recognizes bound %s sandbox paths without guessing an unresolved origin',
  (provider) => {
    expect(
      isOpenShellArtifactSession({ cwd: '/sandbox/workspaces/mgmt', accountBinding: { provider } }),
    ).toBe(true);
    expect(
      isOpenShellArtifactSession(
        { cwd: '/custom/remote-workdir', accountBinding: { provider } },
        '/custom/remote-workdir',
      ),
    ).toBe(true);
    expect(isOpenShellArtifactSession({ cwd: null, accountBinding: { provider } })).toBe(false);
    expect(
      isOpenShellArtifactSession({ cwd: 'relative/workdir', accountBinding: { provider } }),
    ).toBe(false);
  },
);
