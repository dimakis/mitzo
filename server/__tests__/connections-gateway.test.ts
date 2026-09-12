import { describe, expect, it, vi } from 'vitest';
import { OpenShellConnectionGateway } from '../connections-gateway.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const signal = new AbortController().signal;
describe('OpenShellConnectionGateway', () => {
  it('uses the reviewed OpenShell profile schema and never invented provider flags', () => {
    const profile = readFileSync(
      resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
      'utf8',
    );
    expect(profile).toContain('resource_version: 1');
    expect(profile).toContain('env_vars: [JIRA_API_TOKEN]');
    expect(profile).toContain('protocol: rest');
    expect(profile).toContain('enforcement: enforce');
    expect(profile).toContain('tls: terminate');
    expect(profile).not.toContain('credential_keys:');
    expect(profile).not.toContain('inspect_tls:');
  });
  it('uses a key-only credential and never exposes a token in argv or parsed DTOs', async () => {
    const secret = 'SENTINEL_DO_NOT_LEAK';
    const runner = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        JSON.stringify([
          { id: 'p1', name: 'mitzo-conn-12345678', workspace: 'default', type: 'jira-readonly' },
        ]),
      );
    const gateway = new OpenShellConnectionGateway(runner, { workspace: 'default' });
    await gateway.provision({ name: 'mitzo-conn-12345678', token: secret }, signal);
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain(secret);
    expect(runner.mock.calls[0][1].env).toEqual({ JIRA_API_TOKEN: secret });
  });
  it('paginates strict JSON provider metadata', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      name: `mitzo-conn-${String(i).padStart(8, '0')}`,
      workspace: 'default',
      type: 'jira-readonly',
    }));
    const runner = vi.fn().mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce('[]');
    await expect(new OpenShellConnectionGateway(runner).list(signal)).resolves.toHaveLength(100);
    expect(runner.mock.calls[1][0]).toContain('100');
  });
  it('replaces untrusted CLI errors with a fixed safe code', async () => {
    const secret = 'SENTINEL_DO_NOT_LEAK';
    const gateway = new OpenShellConnectionGateway(vi.fn().mockRejectedValue(new Error(secret)));
    await expect(gateway.list(signal)).rejects.toThrow('Gateway command failed');
    await expect(gateway.list(signal)).rejects.not.toThrow(secret);
  });
});
