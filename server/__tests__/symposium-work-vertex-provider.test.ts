import { GoogleAuth } from 'google-auth-library';
import { chmodSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSymposiumWorkVertexProvider,
  captureSymposiumWorkVertexProvider,
  captureSymposiumWorkVertexProviderAsync,
} from '../symposium-work-vertex-provider.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vertex-provider-'));
  roots.push(root);
  const credentialRef = join(root, 'adc.json');
  const material = {
    type: 'authorized_user',
    client_id: 'synthetic-client',
    client_secret: 'synthetic-secret',
    refresh_token: 'synthetic-refresh',
    quota_project_id: 'selected-project',
  };
  writeFileSync(credentialRef, JSON.stringify(material), { mode: 0o600 });
  const profile = {
    id: 'work',
    label: 'Work',
    provider: 'anthropic-vertex' as const,
    credentialRef,
    expectedPrincipal: 'selected@example.test',
    projectId: 'selected-project',
    region: 'global' as const,
    models: [{ id: 'claude-haiku-4-5@20251001', label: 'Haiku' }],
  };
  const gateway = {
    cli: '/pinned/cli',
    gateway: 'fresh',
    workspace: 'private',
    managementEnvironment: { HOME: root, XDG_CONFIG_HOME: root, PATH: '/usr/bin' },
    verifyCustody: vi.fn(),
    verifyCustodyAsync: vi.fn(async () => {}),
  };
  const authenticate = vi.fn(async (value: unknown) => {
    expect(value).toEqual(material);
    return { email: profile.expectedPrincipal, accessToken: 'synthetic-access' };
  });
  let name = '';
  const expiry = Date.now() + 3600_000;
  const date = (n: number) => new Date(n).toISOString().slice(0, 19).replace('T', ' ');
  const run = vi.fn((_file: string, args: string[], _options: unknown) => {
    if (args.includes('create')) name = args[args.indexOf('--name') + 1];
    return {
      status: 0,
      stdout: args.includes('list')
        ? JSON.stringify({
            providers: [
              {
                name,
                id: 'new-id',
                workspace: 'private',
                type: 'google-vertex-ai',
                resource_version: 2,
                credential_keys: ['GOOGLE_VERTEX_AI_TOKEN'],
                credential_expires_at_ms: { GOOGLE_VERTEX_AI_TOKEN: expiry },
              },
            ],
            next_page_token: '',
          })
        : args.includes('status')
          ? 'PROVIDER  CREDENTIAL_KEY  STRATEGY  STATUS  RECOVERY  EXPIRES_AT  NEXT_REFRESH  LAST_REFRESH  FAILURE_CODE  LAST_ERROR\n' +
            [
              name,
              'GOOGLE_VERTEX_AI_TOKEN',
              'oauth2_refresh_token',
              'refreshed',
              '-',
              date(expiry),
              date(expiry - 300000),
              date(Date.now() - 10000),
              '',
              '-',
            ]
              .map((value, index) => value.padEnd([24, 28, 28, 24, 18, 20, 20, 20, 44, 0][index]))
              .join('  ') +
            '\n'
          : '',
    };
  });
  const invoke = () =>
    createSymposiumWorkVertexProvider(gateway as never, profile, {
      authenticate,
      run: run as never,
    });
  return { root, credentialRef, profile, material, gateway, authenticate, run, invoke };
}
it('uses one selected ADC snapshot for verified identity and gateway-only refresh material', async () => {
  const f = fixture();
  f.authenticate.mockImplementation(async (value) => {
    expect(value).toEqual(f.material);
    writeFileSync(f.credentialRef, '{}');
    return { email: f.profile.expectedPrincipal, accessToken: 'synthetic-access' };
  });
  const result = await f.invoke();
  expect(result.sandboxProviderId).toBe('new-id');
  expect(result).not.toHaveProperty('expectedPrincipal');
  expect(f.authenticate).toHaveBeenCalledTimes(1);
  const args = JSON.stringify(f.run.mock.calls.map((c) => c[1]));
  expect(args).not.toMatch(
    /synthetic-secret|synthetic-refresh|synthetic-access|from-gcloud-adc|from-existing/,
  );
  expect(args).toContain('VERTEX_AI_PROJECT_ID=selected-project');
  expect(args).toContain('VERTEX_AI_REGION=global');
  const options = f.run.mock.calls.find((c) => c[1].includes('configure'))![2] as {
    env: Record<string, string>;
  };
  expect(options.env.SYMPOSIUM_VERTEX_REFRESH_TOKEN).toBe('synthetic-refresh');
  expect(options.env.SYMPOSIUM_VERTEX_CLIENT_SECRET).toBe('synthetic-secret');
});
it('rejects mismatched principal before creating any provider', async () => {
  const f = fixture();
  f.authenticate.mockResolvedValue({ email: 'wrong@example.test', accessToken: 'secret' });
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.run).not.toHaveBeenCalled();
});
it('does not read a symlink or accept non-authorized-user credentials', async () => {
  const f = fixture();
  const link = join(f.root, 'link');
  symlinkSync(f.credentialRef, link);
  f.profile.credentialRef = link;
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.authenticate).not.toHaveBeenCalled();
  f.profile.credentialRef = f.credentialRef;
  writeFileSync(f.credentialRef, JSON.stringify({ type: 'external_account' }));
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.authenticate).not.toHaveBeenCalled();
});
it('rejects alias selection before authentication', async () => {
  const f = fixture();
  f.profile.models[0].id = 'claude-haiku-4-5';
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.authenticate).not.toHaveBeenCalled();
});
it('redacts auth and command failures, never publishes partial provider identity', async () => {
  const f = fixture();
  f.authenticate.mockRejectedValue(new Error('synthetic-secret'));
  await expect(f.invoke()).rejects.toThrow(/^Vertex provisioning unavailable$/);
  expect(f.run).not.toHaveBeenCalled();
  const g = fixture();
  g.run.mockImplementation(() => {
    throw Error('synthetic-refresh');
  });
  await expect(g.invoke()).rejects.toThrow(/^Vertex provisioning unavailable$/);
});
it('rechecks custody after authentication before provider dispatch', async () => {
  const f = fixture();
  f.authenticate.mockImplementation(async () => {
    f.gateway.verifyCustody.mockImplementation(() => {
      throw Error('lost');
    });
    return { email: f.profile.expectedPrincipal, accessToken: 'synthetic-access' };
  });
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.run).not.toHaveBeenCalled();
});

it('rejects quota-project drift, public file permissions and oversized snapshots before auth', async () => {
  const f = fixture();
  writeFileSync(
    f.credentialRef,
    JSON.stringify({ ...f.material, quota_project_id: 'wrong-project' }),
  );
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.authenticate).not.toHaveBeenCalled();
  writeFileSync(f.credentialRef, 'x'.repeat(65537));
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.authenticate).not.toHaveBeenCalled();
  chmodSync(f.credentialRef, 0o644);
  writeFileSync(f.credentialRef, JSON.stringify(f.material));
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.authenticate).not.toHaveBeenCalled();
});

it('refuses mismatched provider identity and uncertain refresh without returning a binding', async () => {
  const f = fixture();
  f.run.mockImplementation((_file, args) => ({
    status: 0,
    stdout: args.includes('list') ? JSON.stringify({ providers: [], next_page_token: '' }) : '',
  }));
  await expect(f.invoke()).rejects.toThrow('Vertex provisioning unavailable');
  expect(f.run.mock.calls.some((c) => c[1].includes('configure'))).toBe(false);
  const g = fixture();
  const original = g.run.getMockImplementation()!;
  g.run.mockImplementation((file, args, options) =>
    args.includes('configure')
      ? { status: 1, stdout: 'synthetic-refresh' }
      : original(file, args, options),
  );
  await expect(g.invoke()).rejects.toThrow(/^Vertex provisioning unavailable$/);
});

it('default authentication verifies the same snapshot and requires a verified email', async () => {
  const f = fixture();
  const getTokenInfo = vi.fn(
    async (): Promise<{ email: string; email_verified: boolean | string }> => ({
      email: f.profile.expectedPrincipal,
      email_verified: true,
    }),
  );
  const fromJSON = vi.spyOn(GoogleAuth.prototype, 'fromJSON').mockReturnValue({
    transporter: { defaults: {} },
    getAccessToken: async () => ({ token: 'synthetic-access' }),
    getTokenInfo,
  } as never);
  try {
    await createSymposiumWorkVertexProvider(f.gateway as never, f.profile, { run: f.run as never });
    expect(fromJSON).toHaveBeenCalledWith(f.material);
    expect(getTokenInfo).toHaveBeenCalledWith('synthetic-access');
    getTokenInfo.mockResolvedValue({ email: f.profile.expectedPrincipal, email_verified: 'true' });
    await expect(
      createSymposiumWorkVertexProvider(f.gateway as never, f.profile, { run: f.run as never }),
    ).resolves.toHaveProperty('sandboxProviderId', 'new-id');
    for (const email_verified of [false, 'false', 'TRUE', ' true ', '']) {
      getTokenInfo.mockResolvedValue({ email: f.profile.expectedPrincipal, email_verified });
      f.run.mockClear();
      await expect(
        createSymposiumWorkVertexProvider(f.gateway as never, f.profile, { run: f.run as never }),
      ).rejects.toThrow('Vertex provisioning unavailable');
      expect(f.run).not.toHaveBeenCalled();
    }
  } finally {
    fromJSON.mockRestore();
  }
});

it('requires a gateway-managed initial rotation before publishing the binding', async () => {
  const f = fixture();
  await f.invoke();
  const calls = f.run.mock.calls.map((c) => c[1]);
  const configured = calls.findIndex((a) => a.includes('configure'));
  const rotated = calls.findIndex((a) => a.includes('rotate'));
  expect(rotated).toBeGreaterThan(configured);
  expect(calls[rotated]).toContain('GOOGLE_VERTEX_AI_TOKEN');
  const g = fixture();
  const original = g.run.getMockImplementation()!;
  g.run.mockImplementation((file, args, options) =>
    args.includes('rotate')
      ? { status: 1, stdout: 'synthetic-refresh' }
      : original(file, args, options),
  );
  await expect(g.invoke()).rejects.toThrow('Vertex provisioning unavailable');
});

it('retains verified principal and exact provider intent only under the original gateway custody', async () => {
  const f = fixture();
  const result = await f.invoke();
  const receipt = captureSymposiumWorkVertexProvider(f.gateway as never, result.sandboxProviderId);
  expect(receipt).toEqual({
    principal: f.profile.expectedPrincipal,
    accountId: f.profile.id,
    provider: result.sandboxProvider,
    providerId: 'new-id',
    projectId: 'selected-project',
    region: 'global',
    model: 'claude-haiku-4-5@20251001',
    workspace: 'private',
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(() => captureSymposiumWorkVertexProvider({ ...f.gateway } as never, 'new-id')).toThrow(
    'Vertex provider custody unavailable',
  );
  expect(() => captureSymposiumWorkVertexProvider(f.gateway as never, 'other-id')).toThrow(
    'Vertex provider custody unavailable',
  );
  f.gateway.verifyCustody.mockImplementation(() => {
    throw Error('lost');
  });
  expect(() => captureSymposiumWorkVertexProvider(f.gateway as never, 'new-id')).toThrow(
    'Vertex provider custody unavailable',
  );
  f.gateway.verifyCustody.mockReset();
  expect(() => captureSymposiumWorkVertexProvider(f.gateway as never, 'new-id')).toThrow(
    'Vertex provider custody unavailable',
  );
});

it('rechecks current installed credential readiness on every retained capability capture', async () => {
  const f = fixture();
  const result = await f.invoke();
  const start = f.run.mock.calls.length;
  captureSymposiumWorkVertexProvider(f.gateway as never, result.sandboxProviderId);
  expect(f.run.mock.calls.slice(start).some(([, args]) => args.includes('status'))).toBe(true);
  f.run.mockImplementation(() => ({ status: 1, stdout: 'synthetic-private-diagnostic' }));
  expect(() =>
    captureSymposiumWorkVertexProvider(f.gateway as never, result.sandboxProviderId),
  ).toThrow('Vertex provider readiness unavailable');
});

it('permanently revokes retained identity when custody is lost during a readiness observation', async () => {
  const f = fixture();
  const result = await f.invoke();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation((file, args, options) => {
    const output = original(file, args, options);
    f.gateway.verifyCustody.mockImplementationOnce(() => {
      throw new Error('lost');
    });
    return output;
  });
  expect(() =>
    captureSymposiumWorkVertexProvider(f.gateway as never, result.sandboxProviderId),
  ).toThrow('readiness unavailable');
  f.gateway.verifyCustody.mockReset();
  expect(() =>
    captureSymposiumWorkVertexProvider(f.gateway as never, result.sandboxProviderId),
  ).toThrow('custody unavailable');
});

it('observes retained readiness asynchronously without blocking the parent or invoking sync CLI', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runAsync = vi.fn(async (file: string, args: string[], options: unknown) => {
    await pending;
    return String(f.run.getMockImplementation()!(file, args, options).stdout);
  });
  await createSymposiumWorkVertexProvider(f.gateway as never, f.profile, {
    authenticate: f.authenticate,
    run: f.run as never,
    runAsync,
  });
  const syncCalls = f.run.mock.calls.length;
  const capture = captureSymposiumWorkVertexProviderAsync(f.gateway as never, 'new-id');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(runAsync).toHaveBeenCalledTimes(1);
  expect(f.run).toHaveBeenCalledTimes(syncCalls);
  release();
  const receipt = await capture;
  expect(receipt.providerId).toBe('new-id');
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(runAsync).toHaveBeenCalledTimes(3);
  expect(f.run).toHaveBeenCalledTimes(syncCalls);
  expect(f.gateway.verifyCustodyAsync).toHaveBeenCalled();
  runAsync.mockRejectedValueOnce(new Error('PRIVATE readiness diagnostic'));
  await expect(
    captureSymposiumWorkVertexProviderAsync(f.gateway as never, 'new-id'),
  ).rejects.toThrow('Vertex provider readiness unavailable');
});

it('production async capture leaves the event loop responsive while exact CLI children run', async () => {
  const f = fixture();
  f.gateway.cli = join(f.root, 'public-cli');
  await f.invoke();
  const list = f.run.getMockImplementation()!('', ['list'], {}).stdout;
  const status = f.run.getMockImplementation()!('', ['status'], {}).stdout;
  writeFileSync(
    f.gateway.cli,
    `#!${process.execPath}
setTimeout(() => process.stdout.write(process.argv.includes('list') ? ${JSON.stringify(list)} : ${JSON.stringify(status)}), 60);
`,
    { mode: 0o700 },
  );
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
  }, 5);
  try {
    const count = f.run.mock.calls.length;
    const receipt = await captureSymposiumWorkVertexProviderAsync(f.gateway as never, 'new-id');
    expect(receipt.providerId).toBe('new-id');
    expect(ticks).toBeGreaterThan(5);
    expect(f.run).toHaveBeenCalledTimes(count);
  } finally {
    clearInterval(interval);
  }
});

it('production async capture kills and reaps a stalled exact child within the shared observation bound', async () => {
  const f = fixture();
  f.gateway.cli = join(f.root, 'public-cli');
  await f.invoke();
  const pidFile = join(f.root, 'child-pid');
  writeFileSync(
    f.gateway.cli,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const started = performance.now();
  await expect(
    captureSymposiumWorkVertexProviderAsync(f.gateway as never, 'new-id'),
  ).rejects.toThrow('Vertex provider readiness unavailable');
  expect(performance.now() - started).toBeLessThan(14000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}, 15000);

it('revokes async receipt custody permanently after loss without leaking diagnostics', async () => {
  const f = fixture();
  await f.invoke();
  f.gateway.verifyCustodyAsync.mockRejectedValueOnce(new Error('PRIVATE custody diagnostic'));
  await expect(
    captureSymposiumWorkVertexProviderAsync(f.gateway as never, 'new-id'),
  ).rejects.toThrow('Vertex provider custody unavailable');
  await expect(
    captureSymposiumWorkVertexProviderAsync(f.gateway as never, 'new-id'),
  ).rejects.toThrow('Vertex provider custody unavailable');
});
