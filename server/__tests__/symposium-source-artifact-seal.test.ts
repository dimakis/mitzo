import { expect, it, vi } from 'vitest';
import {
  sealImportedSourceArtifact,
  requireCompletedImportedSourceSeal,
} from '../symposium-source-artifact-seal.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';
import { ARTIFACT_GIT_VERIFIER } from '../symposium-artifact-git-verifier.js';
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
    sessionId: 'session',
    operationId: 'op',
    workspace: 'workspace',
    volumeName: 'mitzo-artifacts-source',
    volumeGeneration: 'generation',
    sourceReceipt: { git, commit: git.commit, tree: git.tree },
  };
  const journal = {
    verifier: vi.fn(),
    intent: vi.fn(),
    created: vi.fn(),
    observed: vi.fn(),
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
    if (args[0] === 'create') return helperId;
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: helperId,
          Name: '/mitzo-artifacts-source-source-seal',
          ImageName: 'image',
          Config: { User: '998:998' },
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
      return JSON.stringify(matches ? git : { ...git, tree: 'f'.repeat(40) });
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
      } as never,
      { image: 'image', uid: 998, gid: 998 },
      'session',
    ),
  ).toThrow(/completed source seal/);
});

it('recovers the same completed source parent digest from the owner ledger', () => {
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
    git,
    sourceReceipt: imported,
    helperId: 'e'.repeat(64),
    helperRemoved: true,
    terminal: { helperId: 'e'.repeat(64), exitCode: 0 },
    verifier: {
      image: 'image',
      codeDigest: createHash('sha256').update(ARTIFACT_GIT_VERIFIER).digest('hex'),
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
  };
  const first = requireCompletedImportedSourceSeal(artifacts as never, owner, 'session');
  expect(first.receipt).toEqual(seal);
  expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(requireCompletedImportedSourceSeal(artifacts as never, owner, 'session')).toEqual(first);
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
