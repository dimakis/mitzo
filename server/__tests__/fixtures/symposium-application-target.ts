import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { GithubRepositoryPreview } from '../../github-repository-source.js';

const git = (directory: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
let source: string;
let baseOid: string;
export const externalGitCalls: string[] = [];

/** Synthetic Local observation metadata, never executable runtime qualification.
 * Called only after the actual-app fixture has fenced host configuration. */
export async function configureApplicationReviewTarget(root: string, fresh: boolean) {
  const login = join(root, 'offline-login');
  const executable = join(root, 'inert-codex');
  const nativePath = join(root, 'native-observation.json');
  const targetPath = join(root, 'target-observation.json');
  source = join(root, 'external-github-source');
  if (fresh) {
    await mkdir(login, { mode: 0o700 });
    await writeFile(
      join(login, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'synthetic-offline' } }),
      { mode: 0o600 },
    );
    // Existing core fixture metadata format. These bytes are never launched.
    const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { ordinaryLocalCodexHostContractRevision } =
      await import('../../ordinary-local-codex-host-runtime.js');
    await writeFile(executable, bytes, { mode: 0o755 });
    await writeFile(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
    await writeFile(
      nativePath,
      JSON.stringify({
        version: 2,
        executablePath: executable,
        executableSha256: sha256,
        codeModeHostSha256: sha256,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      targetPath,
      JSON.stringify({
        version: 1,
        targetId: 'offline-observation',
        label: 'Offline observation',
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256, sha256),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(root, 'accounts.json'),
      JSON.stringify([
        {
          id: 'offline-personal',
          label: 'Offline only',
          provider: 'openai-codex',
          credentialRef: login,
          email: 'offline@example.invalid',
          planType: 'plus',
          models: [{ id: 'fixture-model', label: 'Offline fixture', reasoningEfforts: ['low'] }],
        },
      ]),
      { mode: 0o600 },
    );
    await mkdir(source, { mode: 0o700 });
    git(source, 'init', '-q', '-b', 'main');
    await writeFile(join(source, 'design.txt'), 'Synthetic repository context\n');
    git(source, 'add', 'design.txt');
    git(
      source,
      '-c',
      'user.name=Offline fixture',
      '-c',
      'user.email=offline@example.invalid',
      'commit',
      '-qm',
      'Synthetic source',
    );
  }
  baseOid = git(source, 'rev-parse', 'HEAD');
  // Reopening must consume the original files, not rewrite custody or profiles.
  await readFile(nativePath);
  for (const [key, value] of Object.entries({
    MITZO_CODEX_ENABLED: '1',
    MITZO_REPOSITORY_WORKSPACES_ENABLED: '1',
    MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB: '',
    MITZO_ORDINARY_LOCAL_CODEX_ENABLED: '1',
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
  }))
    vi.stubEnv(key, value);
}

/** External GitHub acquisition boundary only. Canonical parsing, account and
 * connection authorization, ordinary capture and workspace ownership stay real. */
export async function inspectSyntheticGithub(repository: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!source || repository !== 'example/acceptance') throw Error('Unexpected external repository');
  externalGitCalls.push('inspect');
  return { repository, baseBranch: 'main', baseOid };
}
export async function prepareSyntheticGithub(
  preview: GithubRepositoryPreview,
  directory: string,
  branch: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (preview.repository !== 'example/acceptance' || preview.baseOid !== baseOid)
    throw Error('Unexpected source pin');
  externalGitCalls.push('prepare');
  await cp(source, directory, { recursive: true });
  git(directory, 'checkout', '-qb', branch);
  return { ...preview, directory, featureBranch: branch };
}

export async function installApplicationReviewConnections(
  root: string,
  install: typeof import('../../app.js').setConnectionsRuntime,
) {
  const { createConnectionsRuntime } = await import('../../connections-runtime.js');
  const { GitHubCliHostPublisher } =
    await import('../../connections/capabilities/github-publish-pr-transport.js');
  // Only the external identity process is recorded. The actual runtime verifies
  // the current connection identity/revision and all account/repository scope.
  const identity = vi
    .spyOn(GitHubCliHostPublisher.prototype, 'identity')
    .mockImplementation(async (signal) => {
      signal.throwIfAborted();
      externalGitCalls.push('identity');
      return 'offline-operator';
    });
  const runtime = createConnectionsRuntime({
    directory: join(root, 'connections'),
    eligibleAccountIds: () => ['offline-personal'],
    cli: '/nonexistent/offline-gateway-must-not-run',
    workspace: 'offline-observation',
  });
  let connection = runtime.store.list('operator')[0];
  if (!connection) {
    const created = runtime.store.create({
      ownerId: 'operator',
      templateId: 'github-readonly',
      templateVersion: 1,
      label: 'Synthetic GitHub',
      endpoint: 'https://api.github.com',
      gatewayProviderName: 'offline-github',
      desiredAccountIds: ['offline-personal'],
      publicConfig: { allowedRepositories: ['example/acceptance'], allowedBaseBranches: ['main'] },
    });
    connection = runtime.store.transition(
      created.id,
      created.revision,
      {
        status: 'active',
        gatewayProviderId: 'synthetic-provider',
        identity: 'offline-operator',
        verifiedAt: Date.now(),
      },
      { actor: 'operator', operation: 'provision', outcome: 'success' },
    );
  }
  install(runtime);
  return {
    connectionId: connection.id,
    async close() {
      // Caller awaits HTTP completion before releasing the explicit app config.
      install(null);
      runtime.closeOpenAIKeyManagement?.();
      const { closeCapabilityOperationStores } =
        await import('../../capability-operation-owner.js');
      await closeCapabilityOperationStores(new AbortController().signal);
      runtime.store.close();
      identity.mockRestore();
    },
  };
}
