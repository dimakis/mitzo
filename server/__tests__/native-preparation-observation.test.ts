import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as observation from '../native-preparation-observation.js';
import { capturePreparedRepositoryReader } from '../local-repository-native-read.js';
import { executeNativeFileOperation } from '../native-file-operation.js';
import { executeSandboxedCommand } from '../sandboxed-command.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import {
  inspectLocalRepositoryGitMetadata,
  readLocalRepositoryStatus,
} from '../local-repository-git-inspection.js';
import {
  readLocalRepositoryPreparationReferences,
  readLocalRepositoryPreparationBaseReferences,
  readLocalRepositoryGitFacts,
  hasLocalRepositoryReferenceConflict,
} from '../local-repository-git-snapshot.js';
import { captureLocalRepositoryPreparationObjects } from '../local-repository-preparation-objects.js';
import type { NativeFileHelperTransport } from '../native-file-operation.js';

let root: string, source: string, scratch: string;
const identity = async (path: string) => {
  const entry = await lstat(path, { bigint: true });
  return { dev: String(entry.dev), ino: String(entry.ino) };
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-base-observation-')));
  source = join(root, 'source');
  scratch = join(root, 'owned');
  await mkdir(source);
  await mkdir(scratch);
  execFileSync('/usr/bin/git', ['init', '-q', '--template=', '-b', 'main', source], {
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function plan() {
  return {
    version: 'preparation-base-observation-v1' as const,
    sourceAnchor: { rootPath: source, identity: await identity(source) },
    gitDirectory: join(source, '.git'),
    commonAnchor: {
      rootPath: join(source, '.git'),
      identity: await identity(join(source, '.git')),
    },
    deniedRoots: [] as string[],
  };
}
async function scratchTarget() {
  return {
    rootAnchor: { rootPath: scratch, identity: await identity(scratch) },
    file_path: join(scratch, 'capture-0.json'),
  };
}
const transport: NativeFileHelperTransport = async (invocation) => {
  const result = await executeSandboxedCommand({
    command: invocation.command,
    cwd: scratch,
    writableRoots: [scratch],
    deniedRoots: [],
    env: { PATH: '/usr/bin:/bin' },
    signal: invocation.signal,
    timeoutMs: invocation.timeoutMs,
    maxOutputBytes: invocation.maxOutputBytes,
    privateOutput: 'separate',
  });
  return { stdout: result.stdout ?? '', isError: result.isError };
};
it('projects exact immutable plan data without invoking accessors or admitting malformed paths', async () => {
  const input = await plan(),
    captured = observation.freezeNativePreparationObservationPlan(input);
  input.sourceAnchor.identity.ino = '0';
  input.deniedRoots.push('/after');
  expect(captured.sourceAnchor.identity.ino).not.toBe('0');
  expect(captured.deniedRoots).toEqual([]);
  expect(Object.isFrozen(captured.commonAnchor.identity)).toBe(true);
  const getter = vi.fn();
  const bad = Object.defineProperty({ ...(await plan()) }, 'gitDirectory', { get: getter });
  expect(() => observation.freezeNativePreparationObservationPlan(bad)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  for (const gitDirectory of ['relative', '/unsafe/../path', '/bad\0path'])
    expect(() =>
      observation.freezeNativePreparationObservationPlan({ ...captured, gitDirectory }),
    ).toThrow();
});
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'captures ordinary metadata and physically verifies the same witness after parsing without source effects',
  async () => {
    const input = await plan(),
      target = await scratchTarget(),
      signal = new AbortController().signal;
    const before = await readFile(join(source, '.git', 'HEAD'));
    const captured = await observation.captureNativePreparationObservation(
      input,
      target,
      signal,
      15000,
      transport,
    );
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured.observation.files.some((file) => file.name === 'HEAD')).toBe(true);
    await observation.verifyNativePreparationObservation(
      input,
      target,
      captured.witness,
      signal,
      15000,
      transport,
    );
    expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(before);
    expect((await lstat(target.file_path)).isFile()).toBe(true);
  },
  30000,
);
actual(
  'refuses changed regular metadata before exposing a fresh verification result',
  async () => {
    const input = await plan(),
      target = await scratchTarget(),
      signal = new AbortController().signal;
    const captured = await observation.captureNativePreparationObservation(
      input,
      target,
      signal,
      15000,
      transport,
    );
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/replaced\n');
    await expect(
      observation.verifyNativePreparationObservation(
        input,
        target,
        captured.witness,
        signal,
        15000,
        transport,
      ),
    ).rejects.toThrow();
  },
  30000,
);
it('requires private transport for capture and verification before any launch', async () => {
  const input = await plan(),
    target = await scratchTarget(),
    signal = new AbortController().signal;
  await expect(
    observation.captureNativePreparationObservation(
      input,
      target,
      signal,
      15000,
      undefined as never,
    ),
  ).rejects.toThrow();
});

const git = (directory: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
async function view(input: Awaited<ReturnType<typeof plan>>) {
  const target = await scratchTarget(),
    signal = new AbortController().signal;
  let captured: observation.NativePreparationObservationCapture | undefined;
  const forbidden = vi.fn(async () => {
    throw Error('Uncaptured fallback forbidden');
  });
  const authority = {
    deniedRoots: input.deniedRoots,
    deadline: Date.now() + 30000,
    signal,
    assertReadable: vi.fn(async () => {}),
    captureReadAnchor: forbidden,
    executeReadOperation: forbidden,
    capturePreparationObservation: async () => {
      captured = await observation.captureNativePreparationObservation(
        input,
        target,
        signal,
        15000,
        transport,
      );
      return captured;
    },
    verifyPreparationObservation: async (
      actual: observation.NativePreparationObservationCapture,
    ) => {
      expect(actual).toBe(captured);
      await observation.verifyNativePreparationObservation(
        input,
        target,
        actual.witness,
        signal,
        15000,
        transport,
      );
    },
  };
  const access = await LocalRepositoryReadAccess.capturePreparationBase(authority, input);
  return { access, authority, forbidden };
}
actual.each(['ordinary', 'linked', 'sha256'] as const)(
  'runs unchanged preparation parsers through the explicit compact %s view',
  async (kind) => {
    if (kind === 'sha256') {
      await rm(join(source, '.git'), { recursive: true });
      git(source, 'init', '-q', '--template=', '--object-format=sha256', '-b', 'main');
    }
    git(source, 'config', 'user.name', 'Offline');
    git(source, 'config', 'user.email', 'offline@example.invalid');
    await writeFile(join(source, 'tracked'), 'source');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'fixture');
    git(source, 'branch', 'other/β');
    git(source, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    git(source, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/other/β');
    const common = join(source, '.git');
    if (kind === 'linked') {
      const linked = join(root, 'linked');
      git(source, 'worktree', 'add', '-q', '-b', 'linked', linked);
      source = linked;
    }
    const input = {
      version: 'preparation-base-observation-v1' as const,
      sourceAnchor: { rootPath: source, identity: await identity(source) },
      gitDirectory: common,
      commonAnchor: { rootPath: common, identity: await identity(common) },
      deniedRoots: [] as string[],
    };
    input.gitDirectory = kind === 'linked' ? join(common, 'worktrees', 'linked') : common;
    input.commonAnchor = { rootPath: common, identity: await identity(common) };
    const { access, forbidden, authority } = await view(input);
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: source,
      mode: 'preparation',
      readAccess: access,
      assertReadable: (path) => access.assertPath(path),
      timeoutMs: 15000,
    });
    const options = { readAccess: access, timeoutMs: 15000 };
    const facts = await readLocalRepositoryPreparationBaseReferences(metadata, options);
    expect(facts.head).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(facts.branch).toBe(git(source, 'branch', '--show-current'));
    expect(access.preparationObservationOnly).toBe(true);
    expect(facts.referenceCoverage).toBe('preparation-base-observation-v1');
    expect(metadata.baseObservationCoverage).toBe('preparation-base-observation-v1');
    const untouched = authority.assertReadable.mock.calls.length;
    await expect(readLocalRepositoryPreparationReferences(metadata, options)).rejects.toThrow(
      'preparation-observation-only',
    );
    await expect(
      readLocalRepositoryPreparationBaseReferences(
        { ...metadata, baseObservationCoverage: undefined },
        options,
      ),
    ).rejects.toThrow('preparation-observation-required');
    await expect(
      captureLocalRepositoryPreparationObjects(metadata, {
        readAccess: access,
        baseOid: facts.head!,
        timeoutMs: 15000,
      }),
    ).rejects.toThrow();
    await expect(
      readLocalRepositoryGitFacts(
        { ...metadata, qualification: undefined, referenceCoverage: undefined },
        options,
      ),
    ).rejects.toThrow('preparation-observation-only');
    await expect(
      readLocalRepositoryPreparationReferences(metadata, options, 'refs/heads/mitzo/new'),
    ).rejects.toThrow('preparation-observation-only');
    await expect(
      hasLocalRepositoryReferenceConflict(metadata, options, 'refs/heads/main'),
    ).rejects.toThrow('preparation-observation-only');
    await expect(
      readLocalRepositoryStatus(
        { ...metadata, qualification: undefined, referenceCoverage: undefined },
        options,
      ),
    ).rejects.toThrow('preparation-observation-only');
    await expect(
      inspectLocalRepositoryGitMetadata({
        path: source,
        mode: 'references',
        readAccess: access,
        assertReadable: (path) => access.assertPath(path),
        timeoutMs: 15000,
      }),
    ).rejects.toThrow('preparation-observation-only');
    expect(authority.assertReadable.mock.calls.length).toBe(untouched);
    await expect(access.stat(join(common, 'refs', 'heads', 'unconsumed'))).rejects.toThrow();
    await expect(access.read(join(common, 'objects', 'unconsumed'), 1)).rejects.toThrow();
    expect(forbidden).not.toHaveBeenCalled();
    await access.verify();
  },
  30000,
);
actual(
  'retains the complete bounded packed-file capacity rather than truncating the compact envelope',
  async () => {
    const input = await plan(),
      target = await scratchTarget(),
      signal = new AbortController().signal;
    const packed = Buffer.alloc(16 * 1024 * 1024, 120);
    packed[0] = 35;
    packed[packed.length - 1] = 10;
    await writeFile(join(input.commonAnchor.rootPath, 'packed-refs'), packed);
    const captured = await observation.captureNativePreparationObservation(
      input,
      target,
      signal,
      15000,
      transport,
    );
    const bytes = Buffer.from(
      captured.observation.files.find((file) => file.name === 'packed-refs')!.bytes,
      'base64',
    );
    expect(bytes.length).toBe(packed.length);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      createHash('sha256').update(packed).digest('hex'),
    );
    await observation.verifyNativePreparationObservation(
      input,
      target,
      captured.witness,
      signal,
      15000,
      transport,
    );
  },
  30000,
);
actual(
  'rejects unsupported fixed metadata kinds and physical optional aliases atomically',
  async () => {
    const input = await plan(),
      target = await scratchTarget(),
      signal = new AbortController().signal;
    await mkdir(join(input.gitDirectory, 'config.worktree'));
    await expect(
      observation.captureNativePreparationObservation(input, target, signal, 15000, transport),
    ).rejects.toThrow();
    await expect(lstat(target.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(input.gitDirectory, 'config.worktree'), { recursive: true });
    await writeFile(join(input.gitDirectory, 'PACKED-REFS'), '# alias only\n');
    const caseInsensitive = await lstat(join(input.gitDirectory, 'packed-refs')).then(
      () => true,
      () => false,
    );
    if (caseInsensitive) {
      await expect(
        observation.captureNativePreparationObservation(input, target, signal, 15000, transport),
      ).rejects.toThrow();
      await expect(lstat(target.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
  30000,
);

it('refuses malformed raw requests, inherited/accessor ports and cancellation before transport', async () => {
  const input = await plan(),
    target = await scratchTarget();
  const launch = vi.fn();
  const signal = new AbortController();
  signal.abort();
  await expect(
    observation.captureNativePreparationObservation(input, target, signal.signal, 15000, launch),
  ).rejects.toThrow();
  expect(launch).not.toHaveBeenCalled();
  const operationGetter = vi.fn(() => 'CapturePreparationObservation');
  const accessorRequest = Object.defineProperty({}, 'operation', { get: operationGetter });
  await expect(
    executeNativeFileOperation(
      accessorRequest as never,
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  expect(operationGetter).not.toHaveBeenCalled();
  const raw = {
    operation: 'CapturePreparationObservation',
    observationPlan: input,
    observationScratch: target,
    file_path: target.file_path,
    identity: target.rootAnchor.identity,
    parentIdentity: target.rootAnchor.identity,
    limit: 1,
    timeoutMs: 15000,
  };
  await expect(
    executeNativeFileOperation(
      { ...raw, content: 'unrelated payload' },
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  await expect(
    executeNativeFileOperation(raw, new AbortController().signal, 15000),
  ).rejects.toThrow();
  const getter = vi.fn();
  const authority = {
    deniedRoots: [],
    deadline: Date.now() + 30000,
    assertReadable: vi.fn(async () => {}),
    captureReadAnchor: vi.fn(),
  };
  Object.defineProperty(authority, 'capturePreparationObservation', { get: getter });
  await expect(
    LocalRepositoryReadAccess.capturePreparationBase(authority, input),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(authority.assertReadable).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
actual(
  'does not stat excluded credential aliases while hashing full eligible listings',
  async () => {
    const input = await plan(),
      target = await scratchTarget();
    await mkdir(join(input.gitDirectory, 'refs', 'heads', 'KEYCHAINS'));
    await writeFile(
      join(input.gitDirectory, 'refs', 'heads', 'KEYCHAINS', 'private-canary'),
      'never inspected',
    );
    let instrumented = 0;
    const guarded: NativeFileHelperTransport = async (invocation) => {
      // Test-only syscall sentinel. Production condition and control flow remain
      // identical; only this entry.stat call fails if exclusion pruning misses.
      const needle = 'child.stat(follow_symlinks=False)';
      expect(invocation.command.includes(needle)).toBe(true);
      instrumented++;
      return transport({
        ...invocation,
        command: invocation.command.replaceAll(
          needle,
          '(None if child.name == "KEYCHAINS" else child.stat(follow_symlinks=False))',
        ),
      });
    };
    const captured = await observation.captureNativePreparationObservation(
      input,
      target,
      new AbortController().signal,
      15000,
      guarded,
    );
    expect(captured.observation.directories.some((item) => item.incomplete)).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('KEYCHAINS');
    await observation.verifyNativePreparationObservation(
      input,
      target,
      captured.witness,
      new AbortController().signal,
      15000,
      guarded,
    );
    expect(instrumented).toBe(2);
  },
  30000,
);
actual(
  'retains same-reader immutable witness identity and fresh callback state after owned creation',
  async () => {
    let live = true;
    const current = () => {
      if (!live) throw Error('owner revoked');
    };
    const scope = {
      bindingRevision: 'fixture-binding',
      profileRevision: 'fixture-profile',
      policyRevision: 'fixture-policy',
      readableRoots: Object.freeze(['/']),
      workspaceRoots: Object.freeze([]),
      deniedRoots: Object.freeze([]),
      signal: new AbortController().signal,
      assertCurrentSync: current,
      revalidate: async () => current(),
    };
    const input = await plan();
    const first = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
    try {
      expect(Object.keys(first)).toEqual([]);
      const held = await first.capturePreparationObservation!(input);
      expect(Object.isFrozen(held.observation.files)).toBe(true);
      await expect(first.verifyPreparationObservation!({ ...held })).rejects.toThrow();
      await first.verifyPreparationObservation!(held);
      await mkdir(join(input.commonAnchor.rootPath, 'worktrees'));
      await expect(first.verifyPreparationObservation!(held)).rejects.toThrow();
      const second = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        await expect(second.verifyPreparationObservation!(held)).rejects.toThrow();
        const fresh = await second.capturePreparationObservation!(input);
        await second.verifyPreparationObservation!(fresh);
        live = false;
        await expect(second.verifyPreparationObservation!(fresh)).rejects.toThrow();
      } finally {
        await second.dispose();
      }
    } finally {
      await first.dispose();
    }
  },
  30000,
);

actual.each(['file', 'root'] as const)(
  'checks original %s state before verification re-reads source bytes',
  async (kind) => {
    const input = await plan(),
      target = await scratchTarget(),
      signal = new AbortController().signal;
    const captured = await observation.captureNativePreparationObservation(
      input,
      target,
      signal,
      15000,
      transport,
    );
    if (kind === 'file') await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/next\n');
    else {
      await rename(source, source + '-retained');
      await mkdir(source);
      await rename(join(source + '-retained', '.git'), join(source, '.git'));
    }
    const trace = join(scratch, 'byte-attempt');
    const guarded: NativeFileHelperTransport = async (invocation) => {
      const needle = 'content = anchored_read(read_request, deadline)';
      expect(invocation.command.includes(needle)).toBe(true);
      return transport({
        ...invocation,
        command: invocation.command.replace(
          needle,
          'open(' + JSON.stringify(trace) + ',"w").close(); ' + needle,
        ),
      });
    };
    await expect(
      observation.verifyNativePreparationObservation(
        input,
        target,
        captured.witness,
        signal,
        15000,
        guarded,
      ),
    ).rejects.toThrow();
    await expect(lstat(trace)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
actual(
  'retains unchanged parser rejection of includes and bounded symbolic cycles',
  async () => {
    const input = await plan(),
      target = await scratchTarget(),
      signal = new AbortController().signal;
    await writeFile(join(source, '.git', 'refs', 'heads', 'main'), 'ref: refs/heads/main\n');
    await expect(
      observation.captureNativePreparationObservation(input, target, signal, 15000, transport),
    ).rejects.toThrow();
    await expect(lstat(target.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(source, '.git', 'refs', 'heads', 'main'));
    await writeFile(join(source, '.git', 'config'), '[include]\n path = never-read\n');
    const { access } = await view(input);
    await expect(
      inspectLocalRepositoryGitMetadata({
        path: source,
        mode: 'preparation',
        readAccess: access,
        assertReadable: (path) => access.assertPath(path),
        timeoutMs: 15000,
      }),
    ).rejects.toThrow('included-configuration-unavailable');
  },
  30000,
);
actual(
  'preserves a valid NEL-suffixed ref under the exact existing JavaScript trimEnd grammar',
  async () => {
    git(source, 'config', 'user.name', 'Offline');
    git(source, 'config', 'user.email', 'offline@example.invalid');
    await writeFile(join(source, 'tracked'), 'source');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'fixture');
    const ref = 'refs/heads/nel\u0085';
    git(source, 'check-ref-format', ref);
    git(source, 'update-ref', ref, git(source, 'rev-parse', 'HEAD'));
    git(source, 'symbolic-ref', 'HEAD', ref);
    const { access } = await view(await plan());
    const metadata = await inspectLocalRepositoryGitMetadata({
      path: source,
      mode: 'preparation',
      readAccess: access,
      assertReadable: (path) => access.assertPath(path),
      timeoutMs: 15000,
    });
    const facts = await readLocalRepositoryPreparationBaseReferences(metadata, {
      readAccess: access,
      timeoutMs: 15000,
    });
    expect(facts.head).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(facts.branch).toBe(git(source, 'branch', '--show-current'));
    await access.verify();
  },
  30000,
);
actual(
  'rejects a control-suffixed ref before any dynamic HEAD-chain directory lookup',
  async () => {
    const input = await plan(),
      target = await scratchTarget(),
      trace = join(scratch, 'invalid-ref-lookup');
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\u001c\n');
    const guarded: NativeFileHelperTransport = (invocation) => {
      const needle = '    def directory(path):\n';
      expect(invocation.command.includes(needle)).toBe(true);
      return transport({
        ...invocation,
        command: invocation.command.replace(
          needle,
          needle +
            '        if path == ' +
            JSON.stringify(join(source, '.git', 'refs')) +
            ': open(' +
            JSON.stringify(trace) +
            ',"w").close()\n',
        ),
      });
    };
    await expect(
      observation.captureNativePreparationObservation(
        input,
        target,
        new AbortController().signal,
        15000,
        guarded,
      ),
    ).rejects.toThrow();
    await expect(lstat(trace)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(target.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
