import { expect, it, vi } from 'vitest';
import { reconcileStagingSourceMerge } from '../../scripts/lib/staging-source-merge.mjs';
const head = 'a'.repeat(40),
  accepted = 'b'.repeat(40),
  token = { epoch: 1, pr: 123, head, nonce: 'original' };
function fixture(state = 'MERGED') {
  const store = {
    sourceMergeStatus: () => ({ state: 'dispatched', pr: 123 }),
    sourceMergeToken: () => token,
    completeSourceMerge: vi.fn(),
    reconcileClosedSourceMerge: vi.fn(),
  };
  const run = vi.fn((program, args) =>
    JSON.stringify(
      args[0] === 'pr'
        ? { state, headRefOid: head, mergeCommit: state === 'MERGED' ? { oid: accepted } : null }
        : { status: 'identical', base_commit: { sha: accepted } },
    ),
  );
  return { store, run };
}
it('actual exact-head accepted merge retains readiness before releasing', () => {
  const f = fixture();
  expect(reconcileStagingSourceMerge(f.store, 123, f.run)).toMatchObject({
    state: 'queued',
    acceptedCommit: accepted,
  });
  expect(f.store.completeSourceMerge).toHaveBeenCalledWith(
    token,
    expect.objectContaining({
      pr: 123,
      acceptedCommit: accepted,
      taskId: 'pr-dimakis-mitzo-123',
      suite: 'http-readiness',
    }),
  );
});
it('open or uncertain GitHub outcome never releases a dispatched source fence', () => {
  const f = fixture('OPEN');
  expect(reconcileStagingSourceMerge(f.store, 123, f.run).state).toBe('pending');
  expect(f.store.completeSourceMerge).not.toHaveBeenCalled();
  expect(f.store.reconcileClosedSourceMerge).not.toHaveBeenCalled();
  f.run.mockImplementation(() => {
    throw Error('network');
  });
  expect(() => reconcileStagingSourceMerge(f.store, 123, f.run)).toThrow();
  expect(f.store.reconcileClosedSourceMerge).not.toHaveBeenCalled();
});
it('wrong merged head or unaccepted source retains capacity', () => {
  const f = fixture();
  f.run.mockReturnValue(
    JSON.stringify({ state: 'MERGED', headRefOid: 'c'.repeat(40), mergeCommit: { oid: accepted } }),
  );
  expect(() => reconcileStagingSourceMerge(f.store, 123, f.run)).toThrow();
  expect(f.store.completeSourceMerge).not.toHaveBeenCalled();
  const g = fixture();
  g.run.mockImplementation((program, args) =>
    JSON.stringify(
      args[0] === 'pr'
        ? { state: 'MERGED', headRefOid: head, mergeCommit: { oid: accepted } }
        : { status: 'diverged', base_commit: { sha: accepted } },
    ),
  );
  expect(() => reconcileStagingSourceMerge(g.store, 123, g.run)).toThrow();
  expect(g.store.completeSourceMerge).not.toHaveBeenCalled();
});
it('only an actually closed unmerged exact PR is a terminal nonmerge reconciliation', () => {
  const f = fixture('CLOSED');
  expect(reconcileStagingSourceMerge(f.store, 123, f.run).state).toBe('closed_unmerged');
  expect(f.store.reconcileClosedSourceMerge).toHaveBeenCalledWith(token);
});
