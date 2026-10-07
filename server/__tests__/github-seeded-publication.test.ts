import { expect, it, vi } from 'vitest';
import { GithubSeededPublication } from '../github-seeded-publication.js';
const state = {
  status: '',
  seedOid: 'a'.repeat(40),
  seedTreeOid: 'b'.repeat(40),
  originalSourceOid: 'c'.repeat(40),
  sourceBranch: 'task',
  commitsAhead: 2,
  changedFiles: ['note.txt'],
};
function fixture() {
  const read = vi.fn().mockResolvedValue({ ...state });
  const project = vi.fn(async (input) => ({
    sourceOid: 'd'.repeat(40),
    sourceBranch: 'mitzo/seeded/test',
    baseOid: input.baseOid ?? 'e'.repeat(40),
    patchSha256: 'unused',
    bundle: Buffer.from('sealed'),
  }));
  const deps = {
    read,
    project,
    baseline: vi.fn().mockResolvedValue({
      seedTreeOid: state.seedTreeOid,
      repository: 'example/repo',
      upstreamOid: 'f'.repeat(40),
      fingerprint: '1'.repeat(64),
    }),
    export: vi.fn().mockResolvedValue(Buffer.from('patch')),
  };
  return {
    deps,
    publisher: new GithubSeededPublication(deps),
    input: {
      source: {
        runtime: 'openshell' as const,
        sandboxName: 'retained',
        workspace: '/sandbox/workspaces/mgmt',
      },
      repositoryPath: '/sandbox/workspaces/mgmt',
      baseBranch: 'main',
      operationId: 'operation',
      signal: new AbortController().signal,
      authorize: vi.fn(),
    },
  };
}
it('pins projection, original commit and baseline into approval across a restart', async () => {
  const f = fixture();
  const first = await f.publisher.inspect(f.input);
  const approval = { sourceOid: first.sourceOid, ...first.seededPublication! };
  const restarted = new GithubSeededPublication(f.deps);
  const again = await restarted.inspect({ ...f.input, approvalInput: approval });
  expect(again).toEqual(first);
  expect(f.deps.project).toHaveBeenLastCalledWith(
    expect.objectContaining({
      baseOid: 'e'.repeat(40),
      originalSourceOid: state.originalSourceOid,
    }),
  );
  expect(restarted.bundle('operation', first.sourceOid, 100).toString()).toBe('sealed');
  await expect(
    restarted.inspect({
      ...f.input,
      approvalInput: { ...approval, seedSourceIdentity: 'different' },
    }),
  ).rejects.toThrow(/after approval/);
});
it('rejects changed source and revoked access before projecting or exporting a bundle', async () => {
  const f = fixture();
  const first = await f.publisher.inspect(f.input);
  const approval = { sourceOid: first.sourceOid, ...first.seededPublication! };
  f.deps.project.mockClear();
  f.deps.read.mockResolvedValue({ ...state, originalSourceOid: '9'.repeat(40) });
  await expect(f.publisher.inspect({ ...f.input, approvalInput: approval })).rejects.toThrow(
    /after approval/,
  );
  expect(f.deps.project).not.toHaveBeenCalled();
  f.deps.read.mockResolvedValue({ ...state });
  f.input.authorize.mockImplementation(() => {
    throw Error('revoked');
  });
  await expect(f.publisher.inspect({ ...f.input, approvalInput: approval })).rejects.toThrow(
    'revoked',
  );
  expect(f.deps.project).not.toHaveBeenCalled();
  expect(() => f.publisher.bundle('operation', 'wrong', 100)).toThrow();
});
it('rejects dirty or excessive task scope before controller network reads', async () => {
  const f = fixture();
  f.deps.read.mockResolvedValue({ ...state, status: ' M note.txt' });
  await expect(f.publisher.inspect(f.input)).rejects.toThrow(/workspace/);
  f.deps.read.mockResolvedValue({
    ...state,
    changedFiles: Array.from({ length: 65 }, (_, i) => `file${i}`),
  });
  await expect(f.publisher.inspect(f.input)).rejects.toThrow(/scope/);
  expect(f.deps.project).not.toHaveBeenCalled();
});
