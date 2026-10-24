import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fixtureReadAnchor,
  fixtureReadExclusions,
} from './fixtures/local-repository-read-owner.js';
import {
  executeNativeAnchoredReadOperation,
  type NativeAnchoredReadRequest,
} from '../native-file-operation.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import {
  sessionLocalRepositoryTools,
  type SessionLocalRepositoryToolOwner,
  type LocalRepositoryReadPolicy,
} from '../session-local-repository-tools.js';

const paths = vi.hoisted(() => ({ resolved: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    realpath: (...args: Parameters<typeof original.realpath>) => {
      paths.resolved.push(String(args[0]));
      return original.realpath(...args);
    },
  };
});

// Descriptor-relative fixture I/O launches the isolated existing Python helper.
vi.setConfig({ testTimeout: 30000 });

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
async function repository(path: string) {
  await mkdir(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.name', 'Offline Fixture');
  git(path, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(path, 'AGENTS.md'), 'Repository instructions\n');
  await writeFile(join(path, 'code.txt'), 'Original\n');
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'fixture');
  return path;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-tools-')));
});
afterEach(async () => {
  paths.resolved.length = 0;
  await rm(root, { recursive: true, force: true });
});
const signal = () => AbortSignal.timeout(30000);

function fixture() {
  let current = true;
  let policyCurrent = true;
  const assertCurrentSync = () => {
    if (!current) throw Error('Native call authority ended');
  };
  const policy: LocalRepositoryReadPolicy = {
    accessScope: { kind: 'roots', roots: [root], deniedRoots: [] },
    discoveryRoots: [root],
    orientationHints: [],
    assertCurrentSync() {
      if (!policyCurrent) throw Error('Read policy changed');
    },
  };
  const dispose = vi.fn();
  // Only the private raw-call producer may supply this context in production.
  // These are lifecycle test doubles; Git reads below use real fixture repositories.
  const owner = {
    capture: vi.fn(
      (toolName: string, input: Record<string, unknown>, callSignal: AbortSignal) =>
        ({
          toolName,
          requestHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
          callId: 'verified-call',
          turnId: 'verified-turn',
          conversationId: 'same-conversation',
          signal: callSignal,
          assertCurrentSync,
          async assertCurrent() {
            assertCurrentSync();
          },
          dispose,
        }) as unknown as NativeHostToolContext,
    ),
    readPolicy: vi.fn(async () => policy),
    captureReadExclusions: vi.fn(fixtureReadExclusions),
    captureReadAnchor: vi.fn(async (_context: NativeHostToolContext, path: string) =>
      fixtureReadAnchor(path),
    ),
    executeReadOperation: vi.fn(
      async (
        _context: NativeHostToolContext,
        request: NativeAnchoredReadRequest,
        signal: AbortSignal,
        timeoutMs: number,
      ) => executeNativeAnchoredReadOperation(request, signal, timeoutMs),
    ),
    assertPathAccess: vi.fn(
      async (_context: NativeHostToolContext, _path: string, _signal: AbortSignal) => {},
    ),
  } satisfies SessionLocalRepositoryToolOwner;
  return {
    owner,
    policy,
    dispose,
    revoke: () => {
      current = false;
    },
    revokePolicy: () => {
      policyCurrent = false;
    },
  };
}
const value = (result: { content: string } | undefined) => JSON.parse(result!.content);

describe('private Local Mac repository read tools', () => {
  it('withholds repository reads when the original enforced execution port is missing', () => {
    const owner = {
      ...fixture().owner,
      executeReadOperation: undefined,
    } as unknown as SessionLocalRepositoryToolOwner;
    expect(sessionLocalRepositoryTools(owner).definitions).toEqual([]);
  });
  it('discovers and inspects unrelated repositories under original call-bound authority', async () => {
    const first = await repository(join(root, 'web'));
    const second = await repository(join(root, 'library'));
    await writeFile(join(second, 'code.txt'), 'Dirty source\n');
    const f = fixture();
    f.policy.orientationHints = [first];
    const tools = sessionLocalRepositoryTools(f.owner);
    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      'DiscoverLocalRepository',
      'InspectLocalRepository',
    ]);
    expect(
      await tools.execute('PrepareLocalRepository', { path: second }, signal()),
    ).toBeUndefined();
    const request = { query: 'library' };
    const selected = value(await tools.execute('DiscoverLocalRepository', request, signal()));
    expect(selected).toMatchObject({ state: 'selected', candidates: [{ path: second }] });
    expect(f.owner.capture.mock.calls[0].slice(0, 2)).toEqual(['DiscoverLocalRepository', request]);
    const inspected = value(
      await tools.execute('InspectLocalRepository', { path: second }, signal()),
    );
    expect(inspected).toMatchObject({ path: second, dirty: { state: 'unknown', entries: [] } });
    expect(
      inspected.instructions.files.some((file: { content: string }) =>
        file.content.includes('Repository instructions'),
      ),
    ).toBe(true);
    expect(f.owner.assertPathAccess).toHaveBeenCalled();
    expect(f.owner.executeReadOperation).toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(2);
    expect(git(second, 'diff')).toContain('Dirty source');
  });

  it('returns missing and ambiguous decisions without enrollment or acquisition', async () => {
    const first = await repository(join(root, 'one', 'service'));
    await repository(join(root, 'two', 'service'));
    const f = fixture();
    f.policy.orientationHints = [first];
    const tools = sessionLocalRepositoryTools(f.owner);
    expect(
      value(await tools.execute('DiscoverLocalRepository', { query: 'absent' }, signal())),
    ).toMatchObject({ state: 'missing', needed: ['source', 'destination'] });
    expect(
      value(await tools.execute('DiscoverLocalRepository', { query: 'service' }, signal())),
    ).toMatchObject({ state: 'ambiguous' });
    expect(
      value(await tools.execute('DiscoverLocalRepository', { path: first }, signal())),
    ).toMatchObject({ state: 'selected', candidates: [{ path: first }] });
  });

  it('rejects client scope claims after capturing exact raw input and before policy or filesystem reads', async () => {
    const f = fixture();
    const request = { query: 'target', accessScope: { kind: 'host-wide' } };
    const result = await sessionLocalRepositoryTools(f.owner).execute(
      'DiscoverLocalRepository',
      request,
      signal(),
    );
    expect(result?.isError).toBe(true);
    expect(f.owner.capture).toHaveBeenCalledWith(
      'DiscoverLocalRepository',
      request,
      expect.anything(),
    );
    expect(f.owner.readPolicy).not.toHaveBeenCalled();
    expect(f.owner.assertPathAccess).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('fails closed without a current policy owner or actual path authority', async () => {
    for (const missing of [
      'capture',
      'readPolicy',
      'assertPathAccess',
      'captureReadAnchor',
      'captureReadExclusions',
      'executeReadOperation',
    ] as const) {
      const f = fixture();
      const owner = {
        ...f.owner,
        [missing]: undefined,
      } as unknown as SessionLocalRepositoryToolOwner;
      const tools = sessionLocalRepositoryTools(owner);
      expect(tools.definitions).toEqual([]);
      expect(
        (await tools.execute('DiscoverLocalRepository', { query: 'target' }, signal()))?.isError,
      ).toBe(true);
    }
  });

  it('rejects a context for another tool or raw request before consulting policy', async () => {
    for (const changes of [{ toolName: 'OtherTool' }, { requestHash: '0'.repeat(64) }]) {
      const f = fixture();
      const capture = f.owner.capture.getMockImplementation()!;
      f.owner.capture.mockImplementation((...args) => ({ ...capture(...args), ...changes }));
      expect(
        (
          await sessionLocalRepositoryTools(f.owner).execute(
            'DiscoverLocalRepository',
            { query: 'target' },
            signal(),
          )
        )?.isError,
      ).toBe(true);
      expect(f.owner.readPolicy).not.toHaveBeenCalled();
      expect(f.dispose).toHaveBeenCalledOnce();
    }
  });

  it('does not allow an actual-access callback to widen the effective scope', async () => {
    const selected = await repository(join(root, 'outside', 'target'));
    await mkdir(join(root, 'allowed'));
    const f = fixture();
    f.policy.accessScope = { kind: 'roots', roots: [join(root, 'allowed')] };
    const result = value(
      await sessionLocalRepositoryTools(f.owner).execute(
        'DiscoverLocalRepository',
        { path: selected },
        signal(),
      ),
    );
    expect(result).toMatchObject({ state: 'access-required', candidates: [] });
  });

  it('checks actual private authority before reading an otherwise allowed repository', async () => {
    const selected = await repository(join(root, 'target'));
    const f = fixture();
    f.owner.assertPathAccess.mockRejectedValue(Error('Read is not authorized'));
    paths.resolved.length = 0;
    const result = value(
      await sessionLocalRepositoryTools(f.owner).execute(
        'DiscoverLocalRepository',
        { path: selected },
        signal(),
      ),
    );
    expect(result).toMatchObject({ state: 'access-required', candidates: [] });
    expect(paths.resolved).not.toContain(selected);
  });

  it('does not probe denied policy roots and applies the owner-projected lexical/canonical union', async () => {
    const denied = await repository(join(root, 'denied', 'target'));
    const alias = join(root, 'denied-alias');
    await symlink(denied, alias);
    const f = fixture();
    f.policy.accessScope = { kind: 'host-wide', deniedRoots: [denied, alias] };
    paths.resolved.length = 0;
    for (const path of [denied, alias]) {
      expect(
        value(
          await sessionLocalRepositoryTools(f.owner).execute(
            'DiscoverLocalRepository',
            { path },
            signal(),
          ),
        ),
      ).toMatchObject({ state: 'access-required', candidates: [] });
    }
    expect(paths.resolved).not.toContain(denied);
    expect(paths.resolved).not.toContain(alias);
  });

  it('drops results when native or policy authority changes during an awaited path check', async () => {
    const selected = await repository(join(root, 'target'));
    for (const revoke of ['revoke', 'revokePolicy'] as const) {
      const f = fixture();
      f.owner.assertPathAccess.mockImplementationOnce(async () => {
        f[revoke]();
      });
      const result = await sessionLocalRepositoryTools(f.owner).execute(
        'InspectLocalRepository',
        { path: selected },
        signal(),
      );
      expect(result?.isError).toBe(true);
      expect(result?.content).not.toContain('Repository instructions');
      expect(f.dispose).toHaveBeenCalledOnce();
    }
  });
});
