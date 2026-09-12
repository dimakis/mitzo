import { describe, expect, it, vi } from 'vitest';
import {
  OpenShellConnectionGateway,
  parseProviderAttachments,
  validateJiraProfileYaml,
} from '../connections-gateway.js';
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
    expect(
      parseProviderAttachments(
        '\x1b[1mNAME\x1b[0m                  \x1b[1mTYPE\x1b[0m  \x1b[1mCREDENTIAL_KEYS\x1b[0m  \x1b[1mCONFIG_KEYS\x1b[0m\nmitzo-conn-12345678  jira  1                0',
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
    expect(() => validateJiraProfileYaml(profile)).not.toThrow();
    expect(() =>
      validateJiraProfileYaml(
        profile
          .replace('resource_version: 1', 'resource_version: 2')
          .replace(
            '    header_name: authorization',
            "    header_name: authorization\n    query_param: ''",
          )
          .replace('binaries:', 'source: imported\nscope: default\nbinaries:'),
      ),
    ).not.toThrow();
  });
  it('rejects endpoint, TLS, credential, inference, and binary policy drift', () => {
    const profile = readFileSync(
      resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
      'utf8',
    );
    for (const replacement of [
      ['host: redhat.atlassian.net', 'host: evil.example'],
      ['port: 443', 'port: 8443'],
      ['access: read-only', 'access: read-write'],
      ['enforcement: enforce', 'enforcement: audit'],
      ['tls: terminate', 'tls: passthrough'],
      ['inference_capable: false', 'inference_capable: true'],
      ['env_vars: [JIRA_API_TOKEN]', 'env_vars: [JIRA_TOKEN]'],
      ['  - /usr/local/bin/curl', '  - /bin/sh'],
    ]) {
      expect(() =>
        validateJiraProfileYaml(profile.replace(replacement[0], replacement[1])),
      ).toThrow('differs');
    }
  });
  it('lints and imports the server-supplied reviewed profile only when absent', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce('[]')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        readFileSync(resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'), 'utf8'),
      );
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      profilePath: resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    });
    await gateway.verifyCompatibility(signal);
    expect(runner.mock.calls[0]![0]).toEqual([
      'provider',
      '--workspace',
      'default',
      'list-profiles',
      '-o',
      'json',
    ]);
    expect(runner.mock.calls[1]![0]).toEqual([
      'provider',
      '--workspace',
      'default',
      'profile',
      'lint',
      '--file',
      resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    ]);
    expect(runner.mock.calls[2]![0]).toEqual([
      'provider',
      '--workspace',
      'default',
      'profile',
      'import',
      '--file',
      resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    ]);
    expect(runner.mock.calls[3]![0]).toContain('export');
  });
  it('validates an existing profile without linting or importing it', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: 'jira-readonly' }]))
      .mockResolvedValueOnce(
        readFileSync(resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'), 'utf8'),
      );
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      profilePath: resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    });
    await gateway.verifyCompatibility(signal);
    expect(runner.mock.calls).toHaveLength(2);
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('lint');
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('import');
    expect(runner.mock.calls[1]![0]).toContain('export');
  });
  it('fails closed when an existing profile differs from the reviewed policy', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: 'jira-readonly' }]))
      .mockResolvedValueOnce(
        readFileSync(resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'), 'utf8').replace(
          'access: read-only',
          'access: read-write',
        ),
      );
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      profilePath: resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    });
    await expect(gateway.verifyCompatibility(signal)).rejects.toThrow('differs');
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('lint');
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('import');
  });
  it('does not lint or import when an existing profile cannot be exported', async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ id: 'jira-readonly' }]))
      .mockRejectedValueOnce(new Error('gateway export unavailable'));
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      profilePath: resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    });
    await expect(gateway.verifyCompatibility(signal)).rejects.toThrow('Gateway command failed');
    expect(runner.mock.calls[0]![0]).toEqual([
      'provider',
      '--workspace',
      'default',
      'list-profiles',
      '-o',
      'json',
    ]);
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('lint');
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('import');
  });
  it('does not import when provider-profile listing is invalid or unknown', async () => {
    const runner = vi.fn().mockResolvedValueOnce('not-json');
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      profilePath: resolve('infra/openshell/providers/mitzo-jira-readonly.yaml'),
    });
    await expect(gateway.verifyCompatibility(signal)).rejects.toThrow();
    expect(runner.mock.calls[0]![0]).toEqual([
      'provider',
      '--workspace',
      'default',
      'list-profiles',
      '-o',
      'json',
    ]);
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('import');
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
  it('confirms provider deletion and only deletes a labeled disposable probe sandbox', async () => {
    const providerRunner = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('[]');
    await expect(
      new OpenShellConnectionGateway(providerRunner).delete('mitzo-conn-12345678', signal),
    ).resolves.toBeUndefined();
    const name = 'mitzo-probe-1234567890abcdef';
    const probeRunner = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ name, phase: 'Ready', labels: {} }]));
    await expect(
      new OpenShellConnectionGateway(probeRunner).deleteSandbox(name, signal),
    ).rejects.toThrow('ownership');
    expect(probeRunner.mock.calls.flatMap((call) => call[0])).not.toContain('delete');
  });
  it('treats an authoritatively absent probe sandbox as completed cleanup', async () => {
    const name = 'mzp-1234567890abcde';
    const runner = vi.fn().mockResolvedValue(JSON.stringify([]));
    await expect(
      new OpenShellConnectionGateway(runner).deleteSandbox(name, signal),
    ).resolves.toBeUndefined();
    expect(runner.mock.calls.flatMap((call) => call[0])).not.toContain('delete');
  });
  it('does not treat a failed or malformed probe lookup as authoritative absence', async () => {
    const name = 'mitzo-probe-1234567890abcdef';
    await expect(
      new OpenShellConnectionGateway(
        vi.fn().mockRejectedValue(new Error('transport down')),
      ).deleteSandbox(name, signal),
    ).rejects.toThrow('Gateway command failed');
    await expect(
      new OpenShellConnectionGateway(vi.fn().mockResolvedValue('not-json')).deleteSandbox(
        name,
        signal,
      ),
    ).rejects.toThrow();
  });
  it('rejects a caller-supplied legacy overlength probe name before creating a sandbox', async () => {
    const gateway = new OpenShellConnectionGateway(vi.fn(), {
      workspace: 'default',
      probeImage: 'approved:image',
      probePolicy: '/approved/policy.yaml',
    });
    await expect(
      gateway.probe(
        {
          providerName: 'mitzo-conn-12345678',
          email: 'person@example.com',
          sandboxName: 'mitzo-probe-1234567890abcdef',
        },
        signal,
      ),
    ).rejects.toThrow('Invalid managed probe sandbox');
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
        return Promise.resolve(
          JSON.stringify([
            { name: createdName, phase: 'Ready', labels: { 'mitzo.connection_probe': '1' } },
          ]),
        );
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
    expect(createdName).toMatch(/^mzp-[a-f0-9]{15}$/);
    expect(createdName).toHaveLength(19);
    expect(create).toContain('-o');
    expect(create).toContain('json');
    expect(exec).toContain('exec');
    expect(exec).toContain('/usr/bin/python3');
    expect(exec.join(' ')).toContain("'Authorization':'Basic '");
    expect(exec.join(' ')).toContain('redirect denied');
    expect(exec.join(' ')).toContain('read(65537)');
  });
  it('recovers an ambiguous create only for the owned ready probe sandbox', async () => {
    const name = 'mzp-1234567890abcde';
    const runner = vi.fn().mockImplementation((args: string[]) => {
      if (args.includes('create')) return Promise.reject(new Error('timed out'));
      if (args.includes('provider') && args.includes('list'))
        return Promise.resolve(
          'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nmitzo-conn-12345678 jira 1 0',
        );
      if (args.includes('sandbox') && args.includes('list'))
        return Promise.resolve(
          JSON.stringify([{ name, phase: 'Ready', labels: { 'mitzo.connection_probe': '1' } }]),
        );
      if (args.includes('exec')) return Promise.resolve(JSON.stringify({ accountId: 'abc' }));
      return Promise.resolve('');
    });
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      probeImage: 'approved:image',
      probePolicy: '/approved/policy.yaml',
    });
    await expect(
      gateway.probe(
        { providerName: 'mitzo-conn-12345678', email: 'person@example.com', sandboxName: name },
        signal,
      ),
    ).resolves.toEqual({ identity: 'abc' });
  });
  it('rejects ambiguous create when the recovered sandbox is unowned', async () => {
    const runner = vi
      .fn()
      .mockImplementation((args: string[]) =>
        args.includes('create')
          ? Promise.reject(new Error('timed out'))
          : Promise.resolve(
              JSON.stringify([{ name: 'mzp-1234567890abcde', phase: 'Ready', labels: {} }]),
            ),
      );
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      probeImage: 'approved:image',
      probePolicy: '/approved/policy.yaml',
    });
    await expect(
      gateway.probe(
        {
          providerName: 'mitzo-conn-12345678',
          email: 'person@example.com',
          sandboxName: 'mzp-1234567890abcde',
        },
        signal,
      ),
    ).rejects.toThrow('Gateway identity probe failed');
  });
  it.each(['absent', 'unowned', 'wrong-provider', 'aborted'])(
    'rejects unsafe create recovery: %s',
    async (kind) => {
      const name = 'mzp-1234567890abcde';
      const controller = new AbortController();
      const runner = vi.fn().mockImplementation(async (args: string[]) => {
        if (args.includes('create')) {
          if (kind === 'aborted') controller.abort();
          throw new Error('timed out');
        }
        if (args.includes('provider'))
          return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nother jira 1 0';
        return JSON.stringify(
          kind === 'absent'
            ? []
            : [
                {
                  name,
                  phase: 'Ready',
                  labels: kind === 'unowned' ? {} : { 'mitzo.connection_probe': '1' },
                },
              ],
        );
      });
      const gateway = new OpenShellConnectionGateway(runner, {
        workspace: 'default',
        probeImage: 'approved:image',
        probePolicy: '/approved/policy.yaml',
      });
      await expect(
        gateway.probe(
          { providerName: 'mitzo-conn-12345678', email: 'person@example.com', sandboxName: name },
          controller.signal,
        ),
      ).rejects.toThrow('Gateway identity probe failed');
      expect(runner.mock.calls.some(([args]) => args.includes('exec'))).toBe(false);
      if (kind === 'aborted') expect(runner).toHaveBeenCalledTimes(1);
    },
  );
});
