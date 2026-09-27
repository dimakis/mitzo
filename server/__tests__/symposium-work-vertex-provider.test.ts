import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymposiumWorkVertexProvider } from '../symposium-work-vertex-provider.js';
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
  };
  const authenticate = vi.fn(async (value: unknown) => {
    expect(value).toEqual(material);
    return { email: profile.expectedPrincipal, accessToken: 'synthetic-access' };
  });
  let name = '';
  const run = vi.fn((_file: string, args: string[], _options: unknown) => {
    if (args.includes('create')) name = args[args.indexOf('--name') + 1];
    return {
      status: 0,
      stdout: args.includes('list')
        ? JSON.stringify({
            providers: [{ name, id: 'new-id', workspace: 'private', type: 'google-vertex-ai' }],
            next_page_token: '',
          })
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
