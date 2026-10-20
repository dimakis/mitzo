import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { vi } from 'vitest';
import { loadAccountProfiles } from '../../account-profiles.js';
import { createConnectionsRuntime } from '../../connections-runtime.js';
import { closeCapabilityOperationStores } from '../../capability-operation-owner.js';
import { githubProfileFingerprint, type CommandRunner } from '../../connections-gateway.js';

/** Actual enrollment/runtime/gate; only external Keychain, gateway CLI and
 * HTTP effects are deterministic. No ready rows or profile ownership are seeded.
 */
export async function enrolledResponsesOwnerFixture(cleanups: Array<() => void | Promise<void>>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-enrolled-source-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private', 'connections');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(root, '.mitzo'), { mode: 0o700 });
  const profilesPath = join(root, 'profiles.json');
  const database = join(root, 'private', 'enrollment', 'accounts.db');
  await writeFile(profilesPath, '[]', { mode: 0o600 });
  for (const [name, value] of Object.entries({
    REPO_PATH: root,
    MITZO_CODEX_PRIVATE_DIR: join(root, 'private'),
    MITZO_ACCOUNT_PROFILES_FILE: profilesPath,
    MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB: database,
    MITZO_CODEX_ENABLED: '1',
    MITZO_INTERNAL_TOKEN_PATH: join(root, 'internal-token'),
  }))
    vi.stubEnv(name, value);
  const key = 'SYNTHETIC_OFFLINE_ENROLLMENT_KEY';
  const secrets = new Map<string, { value: string; version: string; managed: true }>();
  const providers = new Map<
    string,
    {
      name: string;
      id: string;
      workspace: string;
      type: string;
      resource_version: number;
      credential_keys: string[];
      config_keys: string[];
    }
  >();
  const calls: { gateway: string[][]; requests: string[]; keychain: string[] } = {
    gateway: [],
    requests: [],
    keychain: [],
  };
  const profile = load(
    readFileSync(
      new URL(
        '../../../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  Object.assign(profile, { source: 'user', scope: 'workspace', resource_version: 7 });
  const githubProfile = readFileSync(
    new URL('../../../infra/openshell/providers/github-reviewed-profile.json', import.meta.url),
    'utf8',
  );
  const sandboxes = new Map<
    string,
    { name: string; phase: string; labels: Record<string, string>; provider: string }
  >();
  const gateway: CommandRunner = async (args, request) => {
    request.signal.throwIfAborted();
    calls.gateway.push([...args]);
    if (
      JSON.stringify(args) ===
      JSON.stringify([
        'provider',
        'profile',
        'export',
        'mitzo-openai-keychain-spike',
        '--workspace',
        'default',
        '-o',
        'json',
      ])
    )
      return JSON.stringify(profile);
    if (
      JSON.stringify(args) ===
      JSON.stringify([
        'provider',
        'list',
        '--workspace',
        'default',
        '--limit',
        '100',
        '--offset',
        '0',
        '-o',
        'json',
      ])
    )
      return JSON.stringify([...providers.values()]);
    if (args[0] === 'provider' && args[1] === 'create' && args[2] === '--name') {
      const name = args[3];
      if (
        !name ||
        !/^mitzo-openai-[a-f0-9-]{36}$/.test(name) ||
        providers.has(name) ||
        request.env.OPENAI_API_KEY !== key ||
        JSON.stringify(args.slice(4)) !==
          JSON.stringify([
            '--type',
            'mitzo-openai-keychain-spike',
            '--workspace',
            'default',
            '--credential',
            'OPENAI_API_KEY',
          ])
      )
        throw Error('Unexpected offline provider creation');
      providers.set(name, {
        name,
        id: randomUUID(),
        workspace: 'default',
        type: 'mitzo-openai-keychain-spike',
        resource_version: 1,
        credential_keys: ['OPENAI_API_KEY'],
        config_keys: [],
      });
      return 'Created provider';
    }
    if (
      JSON.stringify(args) ===
      JSON.stringify([
        'provider',
        '--workspace',
        'default',
        'profile',
        'export',
        'github',
        '-o',
        'yaml',
      ])
    )
      return githubProfile;
    if (
      JSON.stringify(args) ===
      JSON.stringify([
        'provider',
        '--workspace',
        'default',
        'list',
        '--limit',
        '100',
        '--offset',
        '0',
        '-o',
        'json',
      ])
    )
      return JSON.stringify([...providers.values()]);
    if (
      args[0] === 'provider' &&
      args[1] === '--workspace' &&
      args[2] === 'default' &&
      args[3] === 'create'
    ) {
      const name = args[5];
      if (
        args[4] !== '--name' ||
        !name ||
        !/^mitzo-conn-[a-f0-9-]{36}$/.test(name) ||
        providers.has(name) ||
        JSON.stringify(args.slice(6)) !==
          JSON.stringify(['--type', 'github', '--credential', 'GITHUB_TOKEN']) ||
        request.env.GITHUB_TOKEN !== 'SYNTHETIC_OFFLINE_GITHUB_TOKEN'
      )
        throw Error('Unexpected offline GitHub provider creation');
      providers.set(name, {
        name,
        id: randomUUID(),
        workspace: 'default',
        type: 'github',
        resource_version: 1,
        credential_keys: ['GITHUB_TOKEN'],
        config_keys: [],
      });
      return 'Created provider';
    }
    if (args[0] === 'sandbox' && args[1] === '--workspace' && args[2] === 'default') {
      if (
        args[3] === 'list' &&
        JSON.stringify(args.slice(4)) ===
          JSON.stringify(['--limit', '100', '--offset', '0', '-o', 'json'])
      )
        return JSON.stringify([...sandboxes.values()]);
      if (args[3] === 'create') {
        const name = args[5],
          provider = args[14];
        if (
          args[4] !== '--name' ||
          !name ||
          !/^mzp-[a-f0-9]{15}$/.test(name) ||
          sandboxes.has(name) ||
          !provider ||
          !providers.has(provider) ||
          JSON.stringify(args.slice(6)) !==
            JSON.stringify([
              '--no-auto-providers',
              '--detach',
              '--no-tty',
              '--policy',
              'offline-github-policy',
              '--from',
              'offline-probe-image',
              '--provider',
              provider,
              '--label',
              'mitzo.connection_probe=1',
              '-o',
              'json',
            ])
        )
          throw Error('Unexpected offline probe creation');
        sandboxes.set(name, {
          name,
          phase: 'Ready',
          labels: { 'mitzo.connection_probe': '1' },
          provider,
        });
        return JSON.stringify({ name, phase: 'Ready' });
      }
      if (args[3] === 'provider' && args[4] === 'list' && args.length === 6) {
        const sandbox = sandboxes.get(args[5]);
        if (!sandbox) throw Error('Offline probe missing');
        return `NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\n${sandbox.provider} github 1 0\n`;
      }
      if (args[3] === 'exec') {
        const name = args[5],
          script = args[12];
        if (
          args[4] !== '--name' ||
          !name ||
          !sandboxes.has(name) ||
          JSON.stringify(args.slice(6, 12)) !==
            JSON.stringify(['--no-tty', '--timeout', '15', '--', '/usr/bin/python3', '-c']) ||
          !script?.includes("urllib.request.Request('https://api.github.com/user'") ||
          args.length !== 13
        )
          throw Error('Unexpected offline identity probe');
        return JSON.stringify({ login: 'offline-operator' });
      }
      if (args[3] === 'delete' && args.length === 5 && sandboxes.has(args[4])) {
        sandboxes.delete(args[4]);
        return 'Deleted probe';
      }
    }
    throw Error('Unexpected external gateway command');
  };
  const requestOpenAI: typeof fetch = async (url, init) => {
    const target = String(url);
    if (
      new Headers(init?.headers).get('Authorization') !== `Bearer ${key}` ||
      init?.redirect !== 'error'
    )
      throw Error('Unexpected external HTTP authority');
    calls.requests.push(`${init?.method} ${target}`);
    if (target === 'https://api.openai.com/v1/models/gpt-6-luna' && init?.method === 'GET')
      return Response.json({ id: 'gpt-6-luna' });
    if (target === 'https://api.openai.com/v1/models' && init?.method === 'GET')
      return Response.json({ data: [{ id: 'gpt-6-luna' }] });
    if (target === 'https://api.openai.com/v1/responses' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (
        body.model !== 'gpt-6-luna' ||
        body.reasoning?.effort !== 'low' ||
        body.store !== false ||
        body.max_output_tokens !== 256 ||
        body.input !== 'Verify this API credential.' ||
        body.instructions !== 'Reply with exactly MITZO_KEY_OK. Do not add any other text.'
      )
        throw Error('Unexpected offline validation request');
      return Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'MITZO_KEY_OK' }] }],
      });
    }
    throw Error('Unexpected external HTTP request');
  };
  const runtime = createConnectionsRuntime({
    directory,
    cli: 'must-not-execute-native-gateway',
    workspace: 'default',
    probeImage: 'offline-probe-image',
    probePolicy: 'offline-probe-policy',
    githubProbePolicy: 'offline-github-policy',
    githubProfileFingerprint: githubProfileFingerprint(githubProfile),
    eligibleAccountIds: () => [...loadAccountProfiles().configuredAccountIds()],
    configuredAccountIds: () => loadAccountProfiles().configuredAccountIds(),
    githubPublishEnabled: false,
    openAIEnrollmentDatabase: database,
    openAIAccountEnrollmentEnabled: true,
    externalEffects: {
      gatewayCommand: gateway,
      githubHostCommand: async (command, args, signal) => {
        signal.throwIfAborted();
        if (command !== 'gh' || JSON.stringify(args) !== JSON.stringify(['api', 'user']))
          throw Error('Unexpected external host GitHub command');
        return { stdout: JSON.stringify({ login: 'offline-operator' }), stderr: '' };
      },
      openAIRequest: requestOpenAI,
      enrollmentKeychain: {
        create: async (stdin, signal) => {
          signal.throwIfAborted();
          const input = JSON.parse(stdin);
          const expected = `mitzo.openai.enrollment.${input.version}`;
          if (
            input.service !== expected ||
            input.account !== 'api-key' ||
            input.value !== key ||
            !/^[a-f0-9-]{36}$/.test(input.version) ||
            secrets.has(expected)
          )
            throw Error('Unexpected offline Keychain creation');
          secrets.set(expected, { value: input.value, version: input.version, managed: true });
          calls.keychain.push('create');
          return JSON.stringify({ ok: true });
        },
        request: async (stdin, signal) => {
          signal.throwIfAborted();
          const input = JSON.parse(stdin);
          if (
            input.action !== 'read' ||
            input.account !== 'api-key' ||
            Object.keys(input).sort().join(',') !== 'account,action,service'
          )
            throw Error('Unexpected offline Keychain request');
          const selected = secrets.get(input.service);
          if (!selected) throw Error('Offline Keychain resource missing');
          calls.keychain.push('read');
          return JSON.stringify(selected);
        },
      },
    },
  });
  cleanups.push(async () => {
    await closeCapabilityOperationStores(AbortSignal.timeout(5000));
    runtime.closeOpenAIKeyManagement?.();
    runtime.store.close();
  });
  const enrolled = await runtime.openAIAccounts!.enroll(
    {
      requestId: randomUUID(),
      label: 'Offline Source Account',
      projectLabel: 'Offline source project',
      apiKey: key,
      billingConfirmed: true,
    },
    AbortSignal.timeout(5000),
  );
  const profiles = loadAccountProfiles();
  const binding = profiles.resolve(enrolled.id, 'gpt-6-luna');
  return {
    root,
    directory,
    database,
    profilesPath,
    runtime,
    enrolled,
    binding,
    calls,
    secrets,
    providers,
    requestOpenAI,
    sandboxes,
  };
}
