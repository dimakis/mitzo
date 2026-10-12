import { expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { StagingPipelineStore } from '../../scripts/lib/staging-pipeline-store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStagingPipelineArguments,
  enqueueMergedStagingRequest,
  checkStagingReplicaSnapshots,
  readStagingPipelineReceipt,
  enqueueMergedFeatureRequest,
  readStagingFeaturePlan,
} from '../../scripts/staging-pipeline.mjs';
it('accepts only bounded pipeline operations and rejects source, model and command overrides', () => {
  expect(parseStagingPipelineArguments(['enqueue', '--pr', '123', '--task', 'session-1'])).toEqual({
    command: 'enqueue',
    pr: 123,
    taskId: 'session-1',
  });
  for (const args of [
    ['enqueue', '--pr', '123'],
    ['run-next', '--command', 'anything'],
    ['enqueue', '--pr', '0', '--task', 's'],
    ['run-next', '--model', 'gpt-6-sol'],
    ['run-next', '--root', '/production'],
  ])
    expect(() => parseStagingPipelineArguments(args)).toThrow();
});
it('feature CLI accepts only a reviewed profile selection and exact plan digest', () => {
  expect(
    parseStagingPipelineArguments([
      'enqueue-feature',
      '--pr',
      '123',
      '--task',
      'session',
      '--profile',
      'stage-profile',
    ]),
  ).toEqual({ command: 'enqueue-feature', pr: 123, taskId: 'session', profileId: 'stage-profile' });
  expect(parseStagingPipelineArguments(['feature-plan', '--id', 'selected'])).toEqual({
    command: 'feature-plan',
    id: 'selected',
  });
  expect(parseStagingPipelineArguments(['run-next', '--feature-plan', 'f'.repeat(64)])).toEqual({
    command: 'run-next',
    featurePlanSha256: 'f'.repeat(64),
  });
  for (const args of [
    ['enqueue-feature', '--pr', '123', '--task', 's', '--model', 'gpt-6.1-sol'],
    ['enqueue-feature', '--pr', '123', '--task', 's', '--account', 'production'],
    ['run-next', '--feature-plan', 'true'],
  ])
    expect(() => parseStagingPipelineArguments(args)).toThrow();
});
it('feature enqueue obtains the fresh enrollment revision from the authenticated stage', async () => {
  const store = { enqueue: vi.fn() },
    run = vi.fn(() => JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } }));
  const effects = {
    lookupEnrollment: vi.fn(async () => ({
      profileId: 'stage-profile',
      enrollmentRevision: 'e'.repeat(64),
    })),
  };
  const options = { pr: 123, taskId: 'session', profileId: 'stage-profile' };
  const result = await enqueueMergedFeatureRequest(store, options, effects, run);
  expect(store.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      version: 2,
      suite: 'profile-tools-v1',
      acceptedCommit: 'a'.repeat(40),
      profileId: 'stage-profile',
      enrollmentRevision: 'e'.repeat(64),
    }),
  );
  expect((await enqueueMergedFeatureRequest(store, options, effects, run)).requestId).toBe(
    result.requestId,
  );
  effects.lookupEnrollment.mockResolvedValue({
    profileId: 'other',
    enrollmentRevision: 'e'.repeat(64),
  });
  await expect(enqueueMergedFeatureRequest(store, options, effects, run)).rejects.toThrow();
});
it('read-only feature planning retains the queued reservation and reports the actual selected source', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'feature-plan-'))),
    database = join(root, 'queue.db');
  try {
    const store = new StagingPipelineStore(database);
    store.enqueue({
      version: 2,
      id: 'feature',
      pr: 1,
      taskId: 'session',
      acceptedCommit: 'a'.repeat(40),
      suite: 'profile-tools-v1',
      profileId: 'stage-profile',
      enrollmentRevision: 'e'.repeat(64),
    });
    store.close();
    const bytes = readFileSync(database),
      source = 'b'.repeat(40),
      effects = {
        baseline: vi.fn(async () => source),
        featurePlan: vi.fn(async () => ({
          publicPlan: {
            sourceCommit: source,
            chargedAccount: 'stage-account',
            selectedModel: 'gpt-6.1-luna',
          },
          planSha256: 'f'.repeat(64),
        })),
      };
    expect(await readStagingFeaturePlan(database, 'feature', effects)).toMatchObject({
      requestId: 'feature',
      state: 'queued',
      featurePlanSha256: 'f'.repeat(64),
      featurePlan: {
        sourceCommit: source,
        chargedAccount: 'stage-account',
        selectedModel: 'gpt-6.1-luna',
      },
    });
    expect(readFileSync(database)).toEqual(bytes);
    await expect(readStagingFeaturePlan(database, 'missing', effects)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('accepts only an exact receipt request identifier', () => {
  expect(parseStagingPipelineArguments(['receipt', '--id', 'selected'])).toEqual({
    command: 'receipt',
    id: 'selected',
  });
  for (const args of [
    ['receipt'],
    ['receipt', '--id', '../queue'],
    ['receipt', '--id', 'selected', '--apply'],
  ])
    expect(() => parseStagingPipelineArguments(args)).toThrow();
});
it('receipt lookup never creates a database or writes an enrolled queue', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-receipt-')));
  const database = join(root, 'queue.db');
  try {
    expect(readStagingPipelineReceipt(database, 'missing')).toEqual({
      version: 1,
      requestId: 'missing',
      state: 'missing',
    });
    expect(existsSync(database)).toBe(false);
    const store = new StagingPipelineStore(database);
    store.enqueue({
      id: 'pending',
      pr: 1,
      taskId: 'session',
      acceptedCommit: 'a'.repeat(40),
      suite: 'http-readiness',
    });
    store.close();
    const bytes = readFileSync(database),
      before = statSync(database);
    expect(readStagingPipelineReceipt(database, 'pending')).toMatchObject({
      version: 1,
      requestId: 'pending',
      state: 'queued',
      result: null,
    });
    expect(readFileSync(database)).toEqual(bytes);
    expect(statSync(database).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(database).ctimeMs).toBe(before.ctimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('enqueues the actual accepted merge commit, never a moving PR head', () => {
  const run = vi.fn(() =>
    JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } }),
  );
  const store = { enqueue: vi.fn() };
  enqueueMergedStagingRequest(store, { pr: 123, taskId: 'session' }, run);
  expect(store.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      acceptedCommit: 'a'.repeat(40),
      pr: 123,
      taskId: 'session',
      suite: 'http-readiness',
    }),
  );
  run.mockReturnValue(JSON.stringify({ state: 'OPEN', headRefOid: 'b'.repeat(40) }));
  expect(() => enqueueMergedStagingRequest(store, { pr: 123, taskId: 'session' }, run)).toThrow(
    /accepted/,
  );
  expect(store.enqueue).toHaveBeenCalledTimes(1);
});

it('replica CLI reads bounded public snapshots and flags all missing profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'replica-'));
  const reference = join(root, 'reference.json'),
    stage = join(root, 'stage.json');
  try {
    writeFileSync(
      reference,
      JSON.stringify([
        { id: 'vertex', provider: 'vertex', runtime: 'claude', capabilities: ['tools'] },
      ]),
    );
    writeFileSync(stage, '[]');
    expect(
      parseStagingPipelineArguments(['replica-check', '--reference', reference, '--stage', stage]),
    ).toEqual({ command: 'replica-check', reference, stage });
    expect(checkStagingReplicaSnapshots(reference, stage)).toMatchObject({
      configurationMatches: false,
      issues: [{ profileId: 'vertex', reason: 'missing-profile' }],
    });
    writeFileSync(stage, ' '.repeat(65537));
    expect(() => checkStagingReplicaSnapshots(reference, stage)).toThrow(/Bounded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
