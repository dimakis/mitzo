import { describe, expect, it, vi } from 'vitest';
import { OpenShellConnectionGateway, parseProviderAttachments } from '../connections-gateway.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const signal = new AbortController().signal;
describe('OpenShellConnectionGateway', () => {
  it('parses only the pinned attachment table and fails closed on unknown output', () => {
    expect(parseProviderAttachments('No providers attached to sandbox probe.', 'probe')).toEqual(
      [],
    );
    expect(
      parseProviderAttachments(
        'NAME                  TYPE  CREDENTIAL_KEYS  CONFIG_KEYS\nmitzo-conn-12345678  jira  1                0',
        'probe',
      ),
    ).toEqual(['mitzo-conn-12345678']);
    expect(() => parseProviderAttachments('[]', 'probe')).toThrow('invalid');
  });
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
  it('lints and imports only the server-supplied reviewed profile when absent', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('[]')
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce('');
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      profilePath: '/reviewed/jira.yaml',
    });
    await gateway.verifyCompatibility(signal);
    expect(runner.mock.calls[0][0]).toContain('/reviewed/jira.yaml');
    expect(runner.mock.calls.at(-1)![0]).toContain('import');
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
  it('uses separate detached create and fixed Python Basic-auth exec for identity probing', async () => {
    let createdName = '';
    const runner = vi.fn().mockImplementation((args: string[]) => {
      if (args.includes('create')) {
        createdName = args[args.indexOf('--name') + 1];
        return Promise.resolve(JSON.stringify({ name: createdName, phase: 'Ready' }));
      }
      if (args.includes('provider') && args.includes('list'))
        return Promise.resolve(
          'NAME  TYPE  CREDENTIAL_KEYS  CONFIG_KEYS\nmitzo-conn-12345678  jira  1  0',
        );
      if (args.includes('list') && args.includes('sandbox'))
        return Promise.resolve(JSON.stringify([{ name: createdName, phase: 'Ready' }]));
      if (args.includes('exec')) return Promise.resolve(JSON.stringify({ accountId: 'abc' }));
      return Promise.resolve('');
    });
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      probeImage: 'approved:image',
      probePolicy: '/approved/policy.yaml',
    });
    await expect(
      gateway.probe({ providerName: 'mitzo-conn-12345678', email: 'person@example.com' }, signal),
    ).resolves.toEqual({ identity: 'abc' });
    const create = runner.mock.calls[0][0] as string[];
    const exec = runner.mock.calls.find((call) =>
      (call[0] as string[]).includes('exec'),
    )![0] as string[];
    expect(create).toContain('--detach');
    expect(create).toContain('-o');
    expect(create).toContain('json');
    expect(exec).toContain('exec');
    expect(exec).toContain('/usr/bin/python3');
    expect(exec.join(' ')).toContain("'Authorization':'Basic '");
    expect(exec.join(' ')).toContain('redirect denied');
    expect(exec.join(' ')).toContain('read(65537)');
  });
});
