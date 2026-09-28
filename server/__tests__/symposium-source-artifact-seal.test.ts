import { expect, it, vi } from 'vitest';
import {
  sealImportedSourceArtifact,
  requireCompletedImportedSourceSeal,
  initialSourceExportReceipt,
  assertRetainedInitialSourceExport,
  requireInitialSourceExport,
} from '../symposium-source-artifact-seal.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
import { ARTIFACT_GIT_EXPORT } from '../symposium-artifact-git-export.js';
import { createHash } from 'node:crypto';

it.each([false, true])('requires exact read-only source proof (matches=%s)', async (matches) => {
  const git = {
    version: 1,
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    entries: 1,
    bytes: 2,
    manifestDigest: 'c'.repeat(64),
    committedTreeDigest: 'd'.repeat(64),
  };
  const receipt = {
    state: 'pending',
    sessionId: 'session',
    operationId: 'op',
    workspace: 'workspace',
    volumeName: 'mitzo-artifacts-source',
    volumeGeneration: 'generation',
    sourceReceipt: {
      git,
      commit: git.commit,
      tree: git.tree,
      manifest: {
        baseOid: git.commit,
        treeOid: git.tree,
        baseBranch: 'main',
        featureBranch: 'change',
        targetRepository: 'owner/repo',
      },
    },
  };
  const bundle = Buffer.from('source-bundle');
  const exported = {
    proof: git,
    bundle: bundle.toString('base64'),
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    bytes: bundle.length,
    selection: {
      sourceRef: 'refs/heads/change',
      sourceOid: git.commit,
      baseRef: 'refs/remotes/origin/main',
      baseOid: git.commit,
      defaultBranch: 'main',
      originUrl: 'https://github.com/owner/repo.git',
    },
  };
  const journal = {
    verifier: vi.fn(),
    intent: vi.fn(),
    created: vi.fn(),
    observed: vi.fn(),
    exported: vi.fn(),
    terminal: vi.fn(),
    removed: vi.fn(),
  };
  const artifacts = {
    beginSourceSeal: vi.fn(() => receipt),
    sourceSealHelperReceipt: vi.fn(() => journal),
    completeSourceSeal: vi.fn(() => ({ state: 'complete' })),
  };
  const helperId = 'e'.repeat(64);
  let started = false;
  let helperCommand: string[] = [];
  const command = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'volume')
      return JSON.stringify([
        {
          Name: receipt.volumeName,
          Driver: 'local',
          Options: {},
          UID: 998,
          GID: 998,
          Labels: {
            'openshell.ai/sandbox-attachable': 'true',
            'openshell.ai/sandbox-attachable-workspace': 'workspace',
            'mitzo.symposium.purpose': 'artifacts',
            'mitzo.symposium.session': 'session',
            'mitzo.symposium.workspace': 'workspace',
            'mitzo.symposium.generation': 'generation',
          },
        },
      ]);
    if (args[0] === 'ps') return JSON.stringify([]);
    if (args[0] === 'create') {
      helperCommand = [...args.slice(args.indexOf('image') + 1)];
      return helperId;
    }
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: helperId,
          Name: '/mitzo-artifacts-source-source-seal',
          ImageName: 'image',
          Config: { User: '998:998', Cmd: helperCommand, Entrypoint: ['/usr/bin/python3'] },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false },
          Mounts: [
            {
              Type: 'volume',
              Name: receipt.volumeName,
              Destination: SYMPOSIUM_ARTIFACT_TARGET,
              RW: false,
            },
          ],
          State: { Running: false, Status: started ? 'exited' : 'created', ExitCode: 0 },
        },
      ]);
    if (args[0] === 'start') {
      started = true;
      return JSON.stringify(
        matches ? exported : { ...exported, proof: { ...git, tree: 'f'.repeat(40) } },
      );
    }
    return '';
  });
  const run = sealImportedSourceArtifact(
    {
      artifacts: artifacts as never,
      owner: { image: 'image', uid: 998, gid: 998 },
      workspace: 'workspace',
      custody: vi.fn(),
      assertNoNativeClaims: vi.fn(),
      command,
    },
    'session',
    'op',
    new AbortController().signal,
  );
  if (matches) expect(await run).toEqual({ state: 'complete' });
  else await expect(run).rejects.toThrow(/Git proof/);
  expect(journal.intent).toHaveBeenCalledOnce();
  expect(journal.created).toHaveBeenCalledOnce();
  expect(journal.observed).toHaveBeenCalledTimes(matches ? 1 : 0);
  expect(journal.exported).toHaveBeenCalledTimes(matches ? 1 : 0);
  expect(artifacts.completeSourceSeal).toHaveBeenCalledTimes(matches ? 1 : 0);
  expect(
    command.mock.calls.some(
      ([args]) =>
        args[0] === 'create' &&
        args.includes(
          `type=volume,src=mitzo-artifacts-source,dst=${SYMPOSIUM_ARTIFACT_TARGET},readonly`,
        ),
    ),
  ).toBe(true);
});

it.each([
  'beforeCreate',
  'lostCreate',
  'lostStart',
  'afterExport',
  'lostRemove',
  'afterRemoved',
  'wrongCreatedHelper',
  'runningAfterStart',
  'disappearedAfterStart',
] as const)(
  'resumes the same fenced source seal after %s without replaying completed helper work',
  async (failure) => {
    const git = {
      version: 1,
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      entries: 1,
      bytes: 2,
      manifestDigest: 'c'.repeat(64),
      committedTreeDigest: 'd'.repeat(64),
    };
    const helperId = 'e'.repeat(64);
    const volumeName = 'mitzo-artifacts-source';
    const bundle = Buffer.from('source-bundle');
    const exported = JSON.stringify({
      proof: git,
      bundle: bundle.toString('base64'),
      bytes: bundle.length,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      selection: {
        sourceRef: 'refs/heads/change',
        sourceOid: git.commit,
        baseRef: 'refs/remotes/origin/main',
        baseOid: git.commit,
        defaultBranch: 'main',
        originUrl: 'https://github.com/owner/repo.git',
      },
    });
    const pending: {
      state: string;
      sessionId: string;
      operationId: string;
      volumeName: string;
      volumeGeneration: string;
      sourceReceipt: {
        git: typeof git;
        commit: string;
        manifest: { baseBranch: string; featureBranch: string; targetRepository: string };
      };
      verifier?: { image: string; codeDigest: string };
      helperName?: string;
      helperId?: string;
      git?: unknown;
      terminal?: { helperId: string; exitCode: number };
      helperRemoved?: boolean;
    } = {
      state: 'pending',
      sessionId: 'session',
      operationId: 'op',
      volumeName,
      volumeGeneration: 'generation',
      sourceReceipt: {
        git,
        commit: git.commit,
        manifest: {
          baseBranch: 'main',
          featureBranch: 'change',
          targetRepository: 'owner/repo',
        },
      },
    };
    const journal = {
      verifier: (image: string, codeDigest: string) => {
        pending.verifier = { image, codeDigest };
      },
      intent: (name: string) => {
        pending.helperName = name;
      },
      created: (id: string) => {
        pending.helperId = id;
      },
      observed: (value: unknown) => {
        pending.git = value;
      },
      exported: vi.fn(),
      terminal: (id: string, exitCode: number) => {
        pending.terminal = { helperId: id, exitCode };
      },
      removed: () => {
        pending.helperRemoved = true;
      },
    };
    const artifacts = {
      beginSourceSeal: () => structuredClone(pending),
      sourceSealHelperReceipt: () => journal,
      completeSourceSeal: () => {
        if (failure === 'afterRemoved' && inject) {
          inject = false;
          throw Error('transient completion');
        }
        pending.state = 'complete';
        return structuredClone(pending);
      },
    };
    let exists = false;
    let started = false;
    let commandArgs: string[] = [];
    let inject = true;
    let starts = 0;
    let creates = 0;
    const command = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'volume')
        return JSON.stringify([
          {
            Name: volumeName,
            Driver: 'local',
            Options: {},
            UID: 998,
            GID: 998,
            Labels: {
              'openshell.ai/sandbox-attachable': 'true',
              'openshell.ai/sandbox-attachable-workspace': 'workspace',
              'mitzo.symposium.purpose': 'artifacts',
              'mitzo.symposium.session': 'session',
              'mitzo.symposium.workspace': 'workspace',
              'mitzo.symposium.generation': 'generation',
            },
          },
        ]);
      if (args[0] === 'ps') return JSON.stringify(exists ? [{ Id: helperId }] : []);
      if (args[0] === 'inspect') {
        if (
          failure === 'afterExport' &&
          started &&
          journal.exported.mock.calls.length > 0 &&
          inject
        ) {
          inject = false;
          throw Error('transient terminal inspection');
        }
        return JSON.stringify([
          {
            Id: helperId,
            Name: `/${volumeName}-source-seal`,
            ImageName: 'image',
            Config: {
              User: '998:998',
              Cmd: failure === 'wrongCreatedHelper' ? ['unexpected'] : commandArgs,
              Entrypoint: ['/usr/bin/python3'],
            },
            HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false },
            Mounts: [
              {
                Type: 'volume',
                Name: volumeName,
                Destination: SYMPOSIUM_ARTIFACT_TARGET,
                RW: false,
              },
            ],
            State: {
              Running: failure === 'runningAfterStart' && started,
              Status:
                failure === 'runningAfterStart' && started
                  ? 'running'
                  : started
                    ? 'exited'
                    : 'created',
              ExitCode: 0,
            },
          },
        ]);
      }
      if (args[0] === 'create') {
        creates++;
        if (failure === 'beforeCreate' && inject) {
          inject = false;
          throw Error('transient create');
        }
        exists = true;
        commandArgs = [...args.slice(args.indexOf('image') + 1)];
        if ((failure === 'lostCreate' || failure === 'wrongCreatedHelper') && inject) {
          inject = false;
          throw Error('lost create response');
        }
        return helperId;
      }
      if (args[0] === 'start') {
        starts++;
        started = true;
        if (
          (failure === 'lostStart' ||
            failure === 'runningAfterStart' ||
            failure === 'disappearedAfterStart') &&
          inject
        ) {
          if (failure === 'disappearedAfterStart') exists = false;
          inject = false;
          throw Error('lost start response');
        }
        return exported;
      }
      if (args[0] === 'logs') return exported;
      if (args[0] === 'rm') {
        exists = false;
        if (failure === 'lostRemove' && inject) {
          inject = false;
          throw Error('lost remove response');
        }
        return '';
      }
      throw Error('unexpected command');
    });
    const deps = {
      artifacts: artifacts as never,
      owner: { image: 'image', uid: 998, gid: 998 },
      workspace: 'workspace',
      custody: vi.fn(),
      assertNoNativeClaims: vi.fn(),
      command,
    };
    const run = () =>
      sealImportedSourceArtifact(deps, 'session', 'op', new AbortController().signal);
    await expect(run()).rejects.toThrow();
    if (
      failure === 'wrongCreatedHelper' ||
      failure === 'runningAfterStart' ||
      failure === 'disappearedAfterStart'
    ) {
      await expect(run()).rejects.toThrow(/isolation|uncertain/i);
      expect(creates).toBe(1);
      expect(starts).toBe(failure === 'wrongCreatedHelper' ? 0 : 1);
      expect(pending.state).toBe('pending');
      return;
    }
    expect((await run()).state).toBe('complete');
    expect((await run()).state).toBe('complete');
    expect(starts).toBe(1);
    expect(creates).toBe(failure === 'beforeCreate' ? 2 : 1);
    expect(exists).toBe(false);
  },
);

it('rejects a pending source seal as a parent even with an imported Git receipt', () => {
  expect(() =>
    requireCompletedImportedSourceSeal(
      {
        sourceSealStatus: () => ({ state: 'pending' }),
        sourceImportStatus: () => ({ state: 'imported', admissionIssued: false }),
        getReady: () => ({
          sessionId: 'session',
          volumeName: 'volume',
          volumeGeneration: 'generation',
        }),
        sourceSealExport: () => {
          throw new Error('pending');
        },
      } as never,
      { image: 'image', uid: 998, gid: 998 },
      'session',
    ),
  ).toThrow(/completed source seal/);
});

it('recovers the same completed source parent digest from the owner ledger', async () => {
  const owner = { image: 'image', uid: 998, gid: 998 };
  const git = {
    version: 1,
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    entries: 1,
    bytes: 2,
    manifestDigest: 'c'.repeat(64),
    committedTreeDigest: 'd'.repeat(64),
  };
  const imported = { git, commit: git.commit, tree: git.tree };
  const seal = {
    state: 'complete',
    sessionId: 'session',
    operationId: 'op',
    volumeName: 'volume',
    volumeGeneration: 'generation',
    custody: '/private/owner',
    workspace: 'workspace',
    helperName: 'volume-source-seal',
    git,
    sourceReceipt: imported,
    helperId: 'e'.repeat(64),
    helperRemoved: true,
    terminal: { helperId: 'e'.repeat(64), exitCode: 0 },
    verifier: {
      image: 'image',
      codeDigest: createHash('sha256').update(ARTIFACT_GIT_EXPORT).digest('hex'),
    },
  };
  const artifacts = {
    sourceSealStatus: () => seal,
    sourceImportStatus: () => ({ state: 'imported', admissionIssued: false, receipt: imported }),
    getReady: () => ({
      sessionId: 'session',
      volumeName: 'volume',
      volumeGeneration: 'generation',
    }),
    sourceSealExport: () => ({
      receipt: {
        proof: git,
        selection: {
          sourceRef: 'refs/heads/change',
          sourceOid: git.commit,
          baseRef: 'refs/remotes/origin/main',
          baseOid: git.commit,
          defaultBranch: 'main',
          originUrl: 'https://github.com/owner/repo.git',
        },
        bundleSha256: createHash('sha256').update('bundle').digest('hex'),
        bytes: 6,
      },
      bundle: Buffer.from('bundle'),
    }),
  };
  const first = requireCompletedImportedSourceSeal(artifacts as never, owner, 'session');
  expect(first.receipt).toEqual(seal);
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(requireCompletedImportedSourceSeal(artifacts as never, owner, 'session')).toEqual(first);
  const initial = initialSourceExportReceipt(first, 'copy-op');
  expect(initial.receipt).toMatchObject({
    mode: 'initial',
    sourceSealId: 'op',
    operationId: 'copy-op',
    parentGenerationId: 'generation',
    parentSealDigest: first.digest,
  });
  expect(
    assertRetainedInitialSourceExport(artifacts as never, owner, initial.receipt, initial.bundle),
  ).toBe(true);
  const physicallyCurrent = await requireInitialSourceExport(
    {
      artifacts: artifacts as never,
      owner,
      workspace: 'workspace',
      custody: vi.fn(),
      assertNoNativeClaims: vi.fn(),
      command: vi.fn(async (args: readonly string[]) =>
        args[0] === 'volume'
          ? JSON.stringify([
              {
                Name: 'volume',
                Driver: 'local',
                Options: {},
                UID: 998,
                GID: 998,
                Labels: {
                  'openshell.ai/sandbox-attachable': 'true',
                  'openshell.ai/sandbox-attachable-workspace': 'workspace',
                  'mitzo.symposium.purpose': 'artifacts',
                  'mitzo.symposium.session': 'session',
                  'mitzo.symposium.workspace': 'workspace',
                  'mitzo.symposium.generation': 'generation',
                },
              },
            ])
          : JSON.stringify([]),
      ),
    },
    initial.receipt,
    initial.bundle,
    new AbortController().signal,
  );
  expect(physicallyCurrent).toEqual(initial.receipt.seal);
  expect(() =>
    assertRetainedInitialSourceExport(
      artifacts as never,
      owner,
      initial.receipt,
      Buffer.from('changed'),
    ),
  ).toThrow(/source export/);
  expect(() =>
    requireCompletedImportedSourceSeal(
      {
        ...artifacts,
        sourceImportStatus: () => ({ state: 'imported', admissionIssued: true, receipt: imported }),
      } as never,
      owner,
      'session',
    ),
  ).toThrow(/completed source seal/);
});
