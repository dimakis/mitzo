import { expect, it, vi } from 'vitest';
import {
  parseStagingPipelineArguments,
  enqueueMergedStagingRequest,
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
