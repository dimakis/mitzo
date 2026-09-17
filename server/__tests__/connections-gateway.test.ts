import { describe, expect, it, vi } from 'vitest';
import {
  OpenShellConnectionGateway,
  JIRA_API_ENDPOINT,
  githubProfileFingerprint,
  parseProviderAttachments,
  validateJiraProfileYaml,
} from '../connections-gateway.js';
import type { ProviderPolicy } from '../connections/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const signal = new AbortController().signal;
const githubPolicy: ProviderPolicy = {
  templateId: 'github-readonly',
  templateVersion: 1,
  credentialFieldKeys: ['token'],
  publicConfig: {},
  endpoints: [
    {
      host: 'api.github.com',
      port: 443,
      protocol: 'rest',
      tls: 'terminate',
      redirects: 'deny',
      rules: [{ method: 'GET', path: '/user' }],
      allowedBinaries: [],
    },
  ],
};
describe('OpenShellConnectionGateway', () => {
  it('supports only the reviewed Jira adapter version', () => {
    const gateway = new OpenShellConnectionGateway(vi.fn());
    expect(gateway.supportsTemplate('jira-readonly', 1)).toBe(true);
    expect(gateway.supportsTemplate('jira-readonly', 2)).toBe(false);
    expect(gateway.supportsTemplate('github-readonly', 1)).toBe(false);
    expect(
      new OpenShellConnectionGateway(vi.fn(), {
        workspace: 'default',
        probeImage: 'image',
        githubProbePolicy: 'policy',
        githubProfileFingerprint: 'a'.repeat(64),
      }).supportsTemplate('github-readonly', 1),
    ).toBe(true);
    expect(
      new OpenShellConnectionGateway(vi.fn(), {
        workspace: 'default',
        probeImage: 'image',
        githubProbePolicy: 'policy',
        githubProfileFingerprint: 'a'.repeat(64),
      }).supportsTemplate('github-readonly', 1),
    ).toBe(true);
  });
  it('requires and verifies the reviewed effective built-in GitHub profile before use', async () => {
    const profile = 'id: github\nendpoints:\n  - host: api.github.com\n';
    const runner = vi.fn().mockResolvedValue(profile);
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      probeImage: 'image',
      githubProbePolicy: 'policy',
      githubProfileFingerprint: githubProfileFingerprint(profile),
    });
    expect(gateway.supportsTemplate('github-readonly', 1)).toBe(true);
    await gateway.verifyCompatibility(
      { templateId: 'github-readonly', templateVersion: 1, policy: githubPolicy },
      signal,
    );
    expect(runner.mock.calls[0]![0]).toEqual([
      'provider',
      '--workspace',
      'default',
      'profile',
      'export',
      'github',
      '-o',
      'yaml',
    ]);
    const broadened = new OpenShellConnectionGateway(
      vi.fn().mockResolvedValue(`${profile}binaries:\n  - /bin/sh\n`),
      {
        workspace: 'default',
        probeImage: 'image',
        githubProbePolicy: 'policy',
        githubProfileFingerprint: githubProfileFingerprint(profile),
      },
    );
    await expect(
      broadened.verifyCompatibility(
        { templateId: 'github-readonly', templateVersion: 1, policy: githubPolicy },
        signal,
      ),
    ).rejects.toThrow('differs');
  });
  it.each([
    { label: 'missing', credentialKeys: [] },
    { label: 'wrong', credentialKeys: ['WRONG_TOKEN'] },
    { label: 'extra', credentialKeys: ['JIRA_API_TOKEN', 'EXTRA'] },
  ])('rejects an invalid Jira credential binding: $label', ({ credentialKeys }) => {
    const gateway = new OpenShellConnectionGateway(vi.fn());
    expect(() =>
      gateway.validateBinding({
        templateId: 'jira-readonly',
        templateVersion: 1,
        provider: {
          id: 'provider-1',
          name: 'mitzo-conn-12345678',
          workspace: 'default',
          type: 'jira-readonly',
          credentialKeys: [...credentialKeys],
        },
      }),
    ).toThrow('credential binding changed');
  });
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
    expect(profile).toMatch(/^id: jira-readonly\nresource_version: 1\n/);
    expect(profile).toContain('resource_version: 1');
    expect(profile).toContain('env_vars: [JIRA_API_TOKEN]');
    expect(profile).toContain('protocol: rest');
    expect(profile).toContain('enforcement: enforce');
    expect(profile).toContain('tls: terminate');
    expect(profile).toContain('host: api.atlassian.com');
    expect(profile).toContain('path: /ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/3/**');
    expect(profile).toContain('  - /usr/bin/python3\n  - /usr/bin/curl\n  - /usr/local/bin/curl\n');
    expect(profile).not.toContain('/opt/mgmt-jira-venv/bin/python');
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
      ['host: api.atlassian.com', 'host: evil.example'],
      ['port: 443', 'port: 8443'],
      ['enforcement: enforce', 'enforcement: audit'],
      ['tls: terminate', 'tls: passthrough'],
      ['inference_capable: false', 'inference_capable: true'],
      ['env_vars: [JIRA_API_TOKEN]', 'env_vars: [JIRA_TOKEN]'],
      ['  - /usr/bin/python3', '  - /bin/sh'],
      [
        'method: GET, path: /ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/2/**',
        'method: POST, path: /ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/2/**',
      ],
      [
        '/ex/jira/2b9e35e3-6bd3-4cec-b838-f4249ee02432/rest/api/3/**',
        '/ex/jira/other-tenant/rest/api/3/**',
      ],
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
          'enforcement: enforce',
          'enforcement: audit',
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
    expect(create).toContain(`JIRA_URL=${JIRA_API_ENDPOINT}`);
    expect(exec).toContain(`JIRA_URL=${JIRA_API_ENDPOINT}`);
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
  it('allows the pinned gateway stop grace period when deleting a probe', async () => {
    const name = 'mzp-1234567890abcde';
    const runner = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify([{ name, phase: 'Ready', labels: { 'mitzo.connection_probe': '1' } }]),
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('[]');
    await new OpenShellConnectionGateway(runner).deleteSandbox(name, signal);
    expect(runner.mock.calls[1][1].timeoutMs).toBe(90_000);
  });
  it('waits for authoritative absence after deletion acknowledges a stopping probe', async () => {
    const name = 'mzp-1234567890abcde';
    const owned = JSON.stringify([
      { name, phase: 'Deleting', labels: { 'mitzo.connection_probe': '1' } },
    ]);
    const runner = vi
      .fn()
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce('[]');
    await expect(
      new OpenShellConnectionGateway(runner).deleteSandbox(name, signal),
    ).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(4);
  });
  it('keeps checking asynchronous deletion beyond two seconds within the cleanup deadline', async () => {
    vi.useFakeTimers();
    try {
      const name = 'mzp-1234567890abcde';
      const start = Date.now();
      const owned = JSON.stringify([
        { name, phase: 'Deleting', labels: { 'mitzo.connection_probe': '1' } },
      ]);
      const runner = vi.fn(async (args: readonly string[]) =>
        args.includes('delete') ? '' : Date.now() - start >= 45_000 ? '[]' : owned,
      );
      const done = new OpenShellConnectionGateway(runner).deleteSandbox(name, signal);
      const assertion = expect(done).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    'JIRA_AUTH_REJECTED',
    'JIRA_PERMISSION_DENIED',
    'JIRA_HTTP_ERROR',
    'JIRA_NETWORK_FAILED',
    'untrusted-secret-text',
  ])('only exposes allowlisted probe errors: %s', async (code) => {
    const name = 'mzp-1234567890abcde';
    const runner = vi.fn(async (args: readonly string[]) => {
      if (args.includes('create')) return JSON.stringify({ name, phase: 'Ready' });
      if (args.includes('exec')) return JSON.stringify({ error: code });
      if (args.includes('provider'))
        return 'NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nmitzo-conn-12345678 jira-readonly 1 0';
      return JSON.stringify([{ name, phase: 'Ready', labels: { 'mitzo.connection_probe': '1' } }]);
    });
    const gateway = new OpenShellConnectionGateway(runner, {
      workspace: 'default',
      probeImage: 'image',
      probePolicy: 'policy',
    });
    const promise = gateway.probe(
      { providerName: 'mitzo-conn-12345678', email: 'person@example.com', sandboxName: name },
      signal,
    );
    if (code.startsWith('JIRA_')) await expect(promise).rejects.toMatchObject({ code });
    else {
      const error = await promise.catch((error: unknown) => error);
      expect(error).toMatchObject({ message: 'Gateway identity probe failed' });
      expect(error).not.toHaveProperty('cause');
    }
  });
});
