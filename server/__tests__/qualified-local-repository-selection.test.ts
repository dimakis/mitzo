import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import {
  localRepositoryPreparationSourceFacts,
  type NativeQualifiedLocalRepositoryPreparationSource,
} from '../local-repository-preparation-source.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import { pendingHostTaskDecisionHash, type PendingHostTaskRequest } from '../pending-host-task.js';
import * as legacy from '../local-repository-worktree.js';
import { EventStore } from '../event-store.js';
import { contextDigest } from '../agent-context-compiler.js';

// Real bounded read facts plus fixture-only current callbacks: SQL selection
// evidence, not signed native authorization, object qualification or effects.
let root: string, sourcePath: string, taskRoot: string;
const id = randomUUID();
let initial!: Awaited<ReturnType<typeof captureLocalRepositoryAllocationFacts>>;
let sourceBytes: Buffer[];
const services: RepositoryWorkspaces[] = [];
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex' as const,
  model: 'fixture',
  profileRevision: 'profile',
};
const runtimeBinding = {
  version: 2 as const,
  account: {
    accountId: binding.accountId,
    provider: binding.provider,
    profileRevision: binding.profileRevision,
  },
  harness: { implementation: 'codex' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
};
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-qualified-selection-')));
  sourcePath = join(root, 'source');
  taskRoot = join(root, 'tasks');
  await mkdir(sourcePath);
  await mkdir(taskRoot);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', sourcePath, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    );
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(sourcePath, 'source.txt'), 'ORIGINAL\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  await writeFile(join(sourcePath, 'source.txt'), 'STAGED USER CHANGE\n');
  git('add', 'source.txt');
  await writeFile(join(sourcePath, 'untracked.txt'), 'UNTRACKED USER BYTES\n');
  initial = await captureLocalRepositoryAllocationFacts(
    {
      deniedRoots: [],
      deadline: Date.now() + 30000,
      captureReadAnchor: fixtureReadAnchor,
      assertReadable: async (path) => {
        if (!(
          path === sourcePath ||
          path.startsWith(sourcePath + '/') ||
          path === taskRoot ||
          path.startsWith(taskRoot + '/')
        ))
          throw Error('Fixture scope denied');
      },
    },
    { workspaceId: id, sourcePath, taskRoot },
  );
  sourceBytes = await Promise.all(
    ['.git/HEAD', '.git/index', 'source.txt', 'untracked.txt'].map((name) =>
      readFile(join(sourcePath, name)),
    ),
  );
}, 30000);
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
function fixture() {
  let live = true;
  const current = vi.fn(() => {
    if (!live) throw Error('Original pending owner changed');
  });
  const qualified: NativeQualifiedLocalRepositoryPreparationSource = {
    ...localRepositoryPreparationSourceFacts(initial.facts),
    referenceCoverage: 'preparation-head-and-namespace-v1',
    allocationFacts: initial.facts,
    allocationFactsSha256: initial.factsSha256,
    publicationPackedRefs: initial.publicationPackedRefs,
    assertCurrentSync: current,
    assertCurrent: vi.fn(async () => {
      current();
    }),
    revalidateAllocationFacts: vi.fn(async () => {
      current();
    }),
  };
  const deps = {
    authorize: vi.fn(async () => {
      throw Error('No remote access');
    }),
    assertLocalRepositoryAccess: vi.fn(async () => {
      throw Error('No ambient source reads');
    }),
    ordinaryPreparation: {
      capture: vi.fn(async () => ({
        version: 1 as const,
        originalBinding: binding,
        runtimeBinding,
        credentialDigest: 'a'.repeat(64),
      })),
      assert: vi.fn(async () => {}),
    },
  };
  const directory = join(root, randomUUID());
  const service = new RepositoryWorkspaces(directory, deps);
  services.push(service);
  const request: PendingHostTaskRequest = {
    id,
    binding,
    runtimeBinding,
    conversationId: 'conversation',
    runtimeId: 'runtime',
    nativeTarget: {
      commandId: 'command',
      attempt: 1,
      threadId: 'thread',
      turnId: 'turn',
      generation: 0,
    },
    prepareCallId: 'call',
    requestHash: 'b'.repeat(64),
    taskRoot,
  };
  const input = {
    request,
    oldWorkspace: { kind: 'ordinary' as const, id: 'old', directory: '/fixture/old' },
    source: qualified,
    assertCurrentSync: current,
  };
  return {
    service,
    directory,
    input,
    deps,
    qualified,
    revoke: () => {
      live = false;
    },
  };
}

it('retains actual original allocation facts and digest on the same ready row without ambient source inspection', async () => {
  const f = fixture();
  const capture = vi.spyOn(legacy, 'captureLocalRepository');
  const assert = vi.spyOn(legacy, 'assertLocalRepository');
  const ready = await f.service.selectQualifiedExistingLocalRepository(
    f.input,
    new AbortController().signal,
  );
  expect(ready.id).toBe(id);
  const record = f.service.get(id);
  expect(record.qualifiedLocalPreparation).toEqual({
    version: 1,
    request: f.input.request,
    oldWorkspace: f.input.oldWorkspace,
    allocationFacts: initial.facts,
    allocationFactsSha256: initial.factsSha256,
  });
  expect(record.sourceDigest).toBe(initial.factsSha256);
  expect(record.featureBranch).toBe(initial.facts.featureBranch);
  expect(record.baseOid).toBe(initial.facts.baseOid);
  expect(f.deps.assertLocalRepositoryAccess).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(assert).not.toHaveBeenCalled();
  expect(
    await Promise.all(
      ['.git/HEAD', '.git/index', 'source.txt', 'untracked.txt'].map((name) =>
        readFile(join(sourcePath, name)),
      ),
    ),
  ).toEqual(sourceBytes);
  expect(pendingHostTaskDecisionHash(record.qualifiedLocalPreparation!.allocationFacts)).toBe(
    initial.factsSha256,
  );
});

it.each(['binding', 'sourceDigest', 'featureBranch'] as const)(
  'refuses a substituted retained selection %s without repairing its original record',
  async (field) => {
    const f = fixture();
    await f.service.selectQualifiedExistingLocalRepository(f.input, new AbortController().signal);
    const record = f.service.get(id);
    if (field === 'binding') record.binding = { ...record.binding, model: 'other' };
    if (field === 'sourceDigest') record.sourceDigest = 'f'.repeat(64);
    if (field === 'featureBranch') record.featureBranch = 'mitzo/foreign';
    const db = new Database(join(f.directory, 'workspaces.db'));
    try {
      db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
        JSON.stringify(record),
        id,
      );
      await expect(
        f.service.selectQualifiedExistingLocalRepository(f.input, new AbortController().signal),
      ).rejects.toThrow();
      expect(f.service.get(id)).toEqual(record);
    } finally {
      db.close();
    }
  },
);

it('refuses original owner drift during preparation capture before writing any selection row', async () => {
  const f = fixture();
  f.deps.ordinaryPreparation.capture.mockImplementation(async () => {
    await Promise.resolve();
    f.revoke();
    return {
      version: 1,
      originalBinding: binding,
      runtimeBinding,
      credentialDigest: 'a'.repeat(64),
    };
  });
  await expect(
    f.service.selectQualifiedExistingLocalRepository(f.input, new AbortController().signal),
  ).rejects.toThrow();
  expect(() => f.service.get(id)).toThrow();
});

it.each(['workspaceId', 'taskRoot', 'digest', 'missingFacts', 'coverage'] as const)(
  'refuses uncorrelated or historical-only qualified %s without ambient fallback',
  async (change) => {
    const f = fixture();
    if (change === 'workspaceId') f.input.request = { ...f.input.request, id: randomUUID() };
    if (change === 'taskRoot')
      f.input.request = { ...f.input.request, taskRoot: '/fixture/other-task-root' };
    if (change === 'digest') Object.assign(f.qualified, { allocationFactsSha256: 'f'.repeat(64) });
    if (change === 'missingFacts') Reflect.deleteProperty(f.qualified, 'allocationFacts');
    if (change === 'coverage') Reflect.deleteProperty(f.qualified, 'referenceCoverage');
    await expect(
      f.service.selectQualifiedExistingLocalRepository(f.input, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.deps.assertLocalRepositoryAccess).not.toHaveBeenCalled();
    expect(() => f.service.get(id)).toThrow();
  },
);

it('refuses qualified-only rows in legacy selectors/status/materializers before ambient access or effects', async () => {
  const f = fixture();
  await f.service.selectQualifiedExistingLocalRepository(f.input, new AbortController().signal);
  const original = f.service.get(id);
  const selection = {
    runOn: 'local' as const,
    runtime: { account: runtimeBinding.account, harness: 'codex' as const, targetId: 'mac' },
  };
  await expect(
    f.service.selectExistingLocalRepository(
      binding,
      sourcePath,
      selection,
      new AbortController().signal,
      id,
    ),
  ).rejects.toThrow();
  await expect(f.service.qualifiedStatus(id, binding)).rejects.toThrow();
  await expect(f.service.claim(id, binding, 'legacy', taskRoot, false)).rejects.toThrow();
  await expect(f.service.releaseSource(id, binding, 'legacy')).rejects.toThrow();
  await expect(f.service.prepare(id, binding, new AbortController().signal)).rejects.toThrow();
  expect(f.deps.assertLocalRepositoryAccess).not.toHaveBeenCalled();
  expect(f.service.get(id)).toEqual(original);
});

it.each(['discard', 'reserve', 'silent'] as const)(
  'refuses legacy %s before account/source callbacks, allocation records or historical data removal',
  async (operation) => {
    const f = fixture();
    await f.service.selectQualifiedExistingLocalRepository(f.input, new AbortController().signal);
    const original = f.service.get(id);
    const retained = join(f.directory, id);
    await mkdir(retained);
    await writeFile(join(retained, 'retained-evidence.txt'), 'RETAINED OPERATION EVIDENCE');
    const events = new EventStore(':memory:');
    const db = new Database(join(f.directory, 'workspaces.db'));
    try {
      let attempt: Promise<unknown>;
      if (operation === 'discard') attempt = f.service.discard(id, binding);
      else if (operation === 'reserve')
        attempt = f.service.reserveHostTask({
          id,
          binding,
          conversationId: 'legacy',
          taskRoot,
          runtimeBinding,
          commandFingerprint: 'c'.repeat(64),
          signal: new AbortController().signal,
        });
      else {
        const definition = {
          name: 'Agent',
          descriptor: 'Fixture',
          role: 'agent' as const,
          instructions: 'Offline',
          expectedOutput: 'Evidence',
          acceptanceCriteria: ['Evidence'],
          modelPolicyRole: 'agent' as const,
        };
        attempt = f.service.prepareOrdinarySession(
          {
            id,
            binding,
            taskRoot,
            allocationOperationId: 'legacy-allocation',
            settings: {
              binding: runtimeBinding,
              repositoryWorkspaceId: id,
              selection: {
                version: 1,
                agent: { profileId: 'agent', revision: 1 },
                context: { source: 'none', revision: null },
                permission: { mode: 'agent', revision: 0 },
                model: binding.model,
                thinking: null,
              },
            },
            agentProfile: {
              profileId: 'agent',
              revision: 1,
              definition,
              contentHash: contextDigest(definition),
            },
            signal: new AbortController().signal,
          },
          events,
        );
      }
      await expect(attempt).rejects.toThrow();
      expect(f.deps.ordinaryPreparation.assert).not.toHaveBeenCalled();
      expect(f.deps.assertLocalRepositoryAccess).not.toHaveBeenCalled();
      expect(f.service.get(id)).toEqual(original);
      expect(db.prepare('SELECT * FROM ordinary_preparation_allocations').all()).toEqual([]);
      expect(await readFile(join(retained, 'retained-evidence.txt'), 'utf8')).toBe(
        'RETAINED OPERATION EVIDENCE',
      );
    } finally {
      db.close();
      events.close();
    }
  },
);
