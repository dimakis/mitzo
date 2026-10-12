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
