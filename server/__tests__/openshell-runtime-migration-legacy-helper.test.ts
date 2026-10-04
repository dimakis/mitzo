import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import { CodexConversationStore, type ArtifactRuntime } from '../codex-conversation-store.js';
import {
  OpenShellCheckpointTransport,
  type CheckpointIdentity,
} from '../openshell-checkpoint-transport.js';
import { migrateRetainedRuntime } from '../openshell-runtime-migration.js';

const legacyHelper = join(
  process.cwd(),
  'server/__tests__/fixtures/immutable-runtime-checkpoint-v1.py',
);
const legacyHash = '055a0dbc99bf57c3e9af26bd08f5d1aa94694860da2e5cee6dfd0bcbfaab812f';
const sourceImage = 'sha256:b89016abe4c17850ee31e2c4613697f6a4871356953952b0edcdb4fdfb8db624';
const targetImage = 'sha256:eefa0731c0e41d08cfde069e4975f180017db68f91cbb563fbcbba99ccd063ab';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const binding: AccountBinding = {
  accountLabel: 'Offline fixture',
  accountId: 'account',
  provider: 'codex',
  model: 'offline',
  profileRevision: 'v1',
};
function git(cwd: string, ...args: string[]) {
  return execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}
function fixture(actualImages = false) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-helper-migration-'));
  roots.push(root);
  const imageFor = (name: string) =>
    name === 'original'
      ? 'localhost/mitzo-mgmt-runtime:codex-01600-unified-20261002'
      : 'localhost/mitzo-mgmt-runtime:knowledge-4f526497-049a2766-20261003';
  const inImage = (name: string, argv: readonly string[]) =>
    execFileSync(
      'podman',
      [
        'run',
        '--rm',
        '--network=none',
        '-v',
        root + ':/fixture:rw',
        '--entrypoint',
        argv[0],
        imageFor(name),
        ...argv.slice(1),
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
  const sandboxes = new Map<string, string>();
  let imageHelperExecutions = 0;
  const makeSandbox = (name: string) => {
    const physical = join(root, name);
    sandboxes.set(name, physical);
    mkdirSync(join(physical, '.codex/sessions'), { recursive: true });
    mkdirSync(join(physical, 'workspaces/mgmt'), { recursive: true });
    mkdirSync(join(physical, 'proc'));
    cpSync(legacyHelper, join(physical, 'mitzo-checkpoint.py'));
    return physical;
  };
  const original = makeSandbox('original');
  const workspace = join(original, 'workspaces/mgmt');
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.name', 'Retained User');
  git(workspace, 'config', 'user.email', 'retained@example.invalid');
  git(workspace, 'remote', 'add', 'origin', 'https://example.invalid/owner/task.git');
  const branch = git(workspace, 'branch', '--show-current');
  git(workspace, 'config', `branch.${branch}.remote`, 'origin');
  git(workspace, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
  writeFileSync(join(workspace, 'tracked.md'), 'accepted task\n');
  git(workspace, 'add', '.');
  git(workspace, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'task');
  writeFileSync(join(workspace, 'tracked.md'), 'staged task\n');
  git(workspace, 'add', 'tracked.md');
  writeFileSync(join(workspace, 'tracked.md'), 'dirty task\n');
  writeFileSync(join(workspace, 'untracked.md'), 'untracked task\n');
  writeFileSync(
    join(original, '.codex/sessions/rollout-offline.jsonl'),
    '{"type":"session_meta","payload":{"id":"same-thread"}}\n',
  );
  const db = new Database(join(original, '.codex/queue_1.sqlite'));
  db.exec("CREATE TABLE state(v TEXT); INSERT INTO state VALUES('retained')");
  db.close();
  const runtime = (name: string): ArtifactRuntime => ({
    runtime: {
      sandboxName: name,
      sandboxId: name + '-id',
      resourceVersion: 'r1',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server',
      cli: 'openshell',
      workspace: 'default',
      gateway: 'g',
      gatewayInsecure: false,
    },
    route: { kind: 'api', provider: 'bound-provider', model: 'offline' },
  });
  const source = runtime('original');
  const store = new CodexConversationStore(join(root, 'ledger.db'));
  store.create('chat', binding, root, null, 'ordinary');
  store.bindThread('chat', binding, 'same-thread');
  store.setArtifactRuntime('chat', binding, source);
  const run = async (command: string, args: readonly string[]) => {
    if (command === 'ssh') {
      const name = /sandbox@openshell-([^.]+)\.default/.exec(args.at(-2)!)![1];
      const physical = sandboxes.get(name)!;
      const remote = JSON.parse(
        execFileSync(
          '/usr/bin/python3',
          ['-I', '-c', 'import shlex,json,sys; print(json.dumps(shlex.split(sys.stdin.read())))'],
          { input: args.at(-1), encoding: 'utf8' },
        ),
      ) as string[];
      if (actualImages) {
        if (remote[0] !== 'rm') expect(remote[0]).toBe('/usr/bin/python3');
        if (remote[0] !== 'rm') expect(remote.slice(1, 3)).toEqual(['-I', '-c']);
        const mapped = remote.map((value) =>
          value.startsWith('/sandbox/')
            ? '/fixture/' + name + '/' + value.slice('/sandbox/'.length)
            : value,
        );
        if (remote[0] === 'rm') return inImage(name, mapped);
        return inImage(name, mapped);
      }
      const mapped = remote.map((value) =>
        value.startsWith('/sandbox/') ? join(physical, value.slice('/sandbox/'.length)) : value,
      );
      if (remote[0] === '/sandbox/mitzo-checkpoint.py') {
        imageHelperExecutions++;
        mapped.unshift('/usr/bin/python3');
      }
      if (mapped.includes('capture')) mapped.push('--proc-root', join(physical, 'proc'));
      return execFileSync(mapped[0], mapped.slice(1), { encoding: 'utf8' });
    }
    if (command === 'openshell') {
      const operation = args.includes('download') ? 'download' : 'upload';
      const index = args.indexOf(operation),
        name = args[index + 1],
        physical = sandboxes.get(name)!;
      if (operation === 'download')
        cpSync(join(physical, basename(args[index + 2])), args[index + 3]);
      else cpSync(args[index + 2], join(physical, basename(args[index + 2])));
      return '{}';
    }
    if (actualImages)
      return inImage('target', [
        command,
        ...args.map((value) =>
          value.startsWith(root + '/') ? '/fixture/' + value.slice(root.length + 1) : value,
        ),
      ]);
    return execFileSync(command, [...args], { encoding: 'utf8' });
  };
  const transport = (artifact: ArtifactRuntime) =>
    new OpenShellCheckpointTransport(artifact.runtime, run);
  const identity: CheckpointIdentity = {
    conversation: 'chat',
    thread: 'same-thread',
    binding: JSON.stringify([
      binding.accountId,
      binding.provider,
      binding.model,
      binding.profileRevision,
    ]),
    image: sourceImage,
    policy: 'policy',
    sandboxId: 'original-id',
    resourceVersion: 'r1',
    accountProvider: 'bound-provider',
    accountId: 'account',
    provider: 'codex',
    model: 'offline',
    profileRevision: 'v1',
    runtimeScope: 'default',
    routeKind: 'api',
    routeProvider: 'bound-provider',
  };
  return {
    root,
    original,
    workspace,
    source,
    store,
    identity,
    transport,
    makeSandbox,
    runtime,
    imageHelperExecutions: () => imageHelperExecutions,
    inImage,
  };
}
function identityArgv(identity: CheckpointIdentity) {
  const names: Record<string, string> = {
    sandboxId: 'sandbox-id',
    resourceVersion: 'resource-version',
    accountProvider: 'account-provider',
    accountId: 'account-id',
    profileRevision: 'profile-revision',
    runtimeScope: 'runtime-scope',
    routeKind: 'route-kind',
    routeProvider: 'route-provider',
  };
  return Object.entries(identity).flatMap(([key, value]) => ['--' + (names[key] ?? key), value]);
}
it('preserves actual immutable image helper bytes and rejects its Git-config-losing archive', async () => {
  const f = fixture();
  try {
    expect(createHash('sha256').update(readFileSync(legacyHelper)).digest('hex')).toBe(legacyHash);
    const archive = join(f.root, 'legacy.tar');
    execFileSync('/usr/bin/python3', [
      legacyHelper,
      'capture',
      '--provider-root',
      join(f.original, '.codex'),
      '--workspace-root',
      f.workspace,
      '--output',
      archive,
      '--require-quiescent',
      '--proc-root',
      join(f.original, 'proc'),
      ...identityArgv(f.identity),
    ]);
    expect(execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).split('\n')).not.toContain(
      'workspace/.git/config',
    );
    await expect(
      f.transport(f.source).verify(archive, f.identity, new AbortController().signal),
    ).rejects.toThrow(/Git config is missing/);
    expect(git(f.workspace, 'remote', 'get-url', 'origin')).toBe(
      'https://example.invalid/owner/task.git',
    );
  } finally {
    f.store.close();
  }
});
it.each([false, ...(process.env.MITZO_MIGRATION_IMAGE_FIXTURE === '1' ? [true] : [])])(
  'migrates legacy source into unchanged target image through trusted host capture, restore and recapture: actualImages=%s',
  async (actualImages) => {
    const f = fixture(actualImages);
    const signal = new AbortController().signal;
    const gitConfig = readFileSync(join(f.workspace, '.git/config'));
    const gitIndex = readFileSync(join(f.workspace, '.git/index'));
    const head = git(f.workspace, 'rev-parse', 'HEAD');
    let candidate: ArtifactRuntime | undefined;
    try {
      const selected = await migrateRetainedRuntime({
        conversationId: 'chat',
        binding,
        store: f.store,
        source: f.source,
        targetImage,
        targetPolicy: 'policy',
        supportedSourceImages: [sourceImage],
        adapters: {
          observe: async () => ({ image: sourceImage, policy: 'policy', resourceVersion: 'r1' }),
          quiescent: async () => {},
          capture: async (original, identity) =>
            f.transport(original).capture(join(f.root, 'checkpoint'), identity, signal),
          create: async (name) => {
            f.makeSandbox(name);
            candidate = f.runtime(name);
            return candidate;
          },
          attest: async () => {},
          restore: async (target, checkpoint, identity) =>
            f.transport(target).restore(checkpoint.path, identity, checkpoint.digest, signal),
          verifyRestored: async (target, identity) => {
            const recapture = await f.transport(target).capture(
              join(f.root, 'recapture'),
              {
                ...identity,
                image: targetImage,
                sandboxId: target.runtime.sandboxId!,
                resourceVersion: 'r1',
              },
              signal,
            );
            expect(recapture.digest).toBe(
              f.store.readRuntimeMigration('chat', binding)!.checkpoint!.digest,
            );
            expect(f.store.readArtifactRuntime('chat', binding)).toEqual(f.source);
          },
        },
      });
      expect(selected).toEqual(candidate);
      const restored = join(f.root, candidate!.runtime.sandboxName, 'workspaces/mgmt');
      expect(readFileSync(join(restored, '.git/config'))).toEqual(gitConfig);
      expect(statSync(join(restored, '.git/config')).mode & 0o777).toBe(
        statSync(join(f.workspace, '.git/config')).mode & 0o777,
      );
      expect(readFileSync(join(restored, '.git/index'))).toEqual(gitIndex);
      expect(git(restored, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(restored, 'remote', 'get-url', 'origin')).toBe(
        'https://example.invalid/owner/task.git',
      );
      const branch = git(restored, 'branch', '--show-current');
      expect(git(restored, 'config', `branch.${branch}.merge`)).toBe(`refs/heads/${branch}`);
      expect(readFileSync(join(restored, 'tracked.md'), 'utf8')).toBe('dirty task\n');
      expect(readFileSync(join(restored, 'untracked.md'), 'utf8')).toBe('untracked task\n');
      expect(
        readFileSync(
          join(f.root, candidate!.runtime.sandboxName, '.codex/sessions/rollout-offline.jsonl'),
        ),
      ).toEqual(readFileSync(join(f.original, '.codex/sessions/rollout-offline.jsonl')));
      const db = new Database(
        join(f.root, candidate!.runtime.sandboxName, '.codex/queue_1.sqlite'),
      );
      expect(db.prepare('SELECT v FROM state').get()).toEqual({ v: 'retained' });
      db.close();
      for (const name of ['original', candidate!.runtime.sandboxName])
        expect(
          createHash('sha256')
            .update(readFileSync(join(f.root, name, 'mitzo-checkpoint.py')))
            .digest('hex'),
        ).toBe(legacyHash);
      expect(f.imageHelperExecutions()).toBe(0);
      expect(existsSync(f.original)).toBe(true);
      expect(f.store.readRuntimeMigration('chat', binding)).toMatchObject({
        phase: 'committed',
        identity: { image: sourceImage, sandboxId: 'original-id', thread: 'same-thread' },
      });
    } finally {
      f.store.close();
    }
  },
);

it.skipIf(process.env.MITZO_MIGRATION_IMAGE_FIXTURE !== '1')(
  'proves both cached immutable image helpers lose Git config before trusted-host verification rejects them',
  async () => {
    const f = fixture(true);
    try {
      for (const name of ['original', 'target']) {
        const image =
          name === 'original'
            ? 'localhost/mitzo-mgmt-runtime:codex-01600-unified-20261002'
            : 'localhost/mitzo-mgmt-runtime:knowledge-4f526497-049a2766-20261003';
        expect(
          execFileSync('podman', ['image', 'inspect', image, '--format', '{{.Digest}}'], {
            encoding: 'utf8',
          }).trim(),
        ).toBe(name === 'original' ? sourceImage : targetImage);
        expect(
          createHash('sha256')
            .update(f.inImage(name, ['/bin/cat', '/sandbox/mitzo-checkpoint.py']))
            .digest('hex'),
        ).toBe(legacyHash);
        const archive = join(f.root, 'image-' + name + '.tar');
        f.inImage(name, [
          '/usr/bin/python3',
          '-I',
          '/sandbox/mitzo-checkpoint.py',
          'capture',
          '--provider-root',
          '/fixture/original/.codex',
          '--workspace-root',
          '/fixture/original/workspaces/mgmt',
          '--output',
          '/fixture/' + basename(archive),
          '--require-quiescent',
          ...identityArgv(f.identity),
        ]);
        expect(
          execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).split('\n'),
        ).not.toContain('workspace/.git/config');
        await expect(
          f.transport(f.source).verify(archive, f.identity, new AbortController().signal),
        ).rejects.toThrow(/Git config is missing/);
        expect(
          createHash('sha256')
            .update(f.inImage(name, ['/bin/cat', '/sandbox/mitzo-checkpoint.py']))
            .digest('hex'),
        ).toBe(legacyHash);
      }
    } finally {
      f.store.close();
    }
  },
);
