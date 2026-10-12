import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StagingPipelineStore } from '../../scripts/lib/staging-pipeline-store.mjs';
import { assertStagingPipelineMutation } from '../../scripts/lib/staging-pipeline-mutation-guard.mjs';
const fixtures = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.store?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-guard-')));
  const store = new StagingPipelineStore(join(root, 'queue.db'));
  fixtures.push({ root, store });
  return { root, store };
}
const sha = 'a'.repeat(40),
  r = { id: 'r', taskId: 's', pr: 1, acceptedCommit: sha, suite: 'http-readiness' };
it('legacy mutation remains available only when no pipeline has been enrolled', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-unenrolled-')));
  fixtures.push({ root });
  expect(() => assertStagingPipelineMutation({ target: sha, apply: true }, { root })).not.toThrow();
});
it('direct deploy cannot replace an enrolled baseline outside its reservation', () => {
  const { root, store } = fixture();
  store.enqueue(r);
  expect(() => assertStagingPipelineMutation({ target: sha, apply: true }, { root })).toThrow(
    /reservation/,
  );
  const c = store.claim('worker');
  store.bindBaseline(c.token, sha);
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: false, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).not.toThrow();
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).toThrow(/dispatch/);
  store.markDispatched(c.token);
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).not.toThrow();
  for (const changed of [
    { target: 'b'.repeat(40) },
    { proof: JSON.stringify({ ...c.token, epoch: 2 }) },
  ])
    expect(() =>
      assertStagingPipelineMutation(
        { target: sha, apply: true, proof: JSON.stringify(c.token), ...changed },
        { root },
      ),
    ).toThrow();
});
it('stale and quarantined capabilities cannot be used to deploy', () => {
  const { root, store } = fixture();
  store.enqueue(r);
  const c = store.claim('worker');
  store.bindBaseline(c.token, sha);
  store.markDispatched(c.token);
  store.quarantine(c.token, 'controller-lost');
  expect(() =>
    assertStagingPipelineMutation(
      { target: sha, apply: true, proof: JSON.stringify(c.token) },
      { root },
    ),
  ).toThrow();
});
